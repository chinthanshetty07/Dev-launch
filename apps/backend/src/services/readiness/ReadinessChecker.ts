import { request } from 'node:https';
import type { HealthCheck } from '@devlaunch/shared';

export interface ReadinessOptions {
  host?: string;
  port: string | number;
  healthCheck: HealthCheck;
  timeoutMs: number;
  /** `https` for an application that serves TLS itself (`RunPlan.protocol`). */
  protocol?: 'http' | 'https';
  /** Consulted between attempts; returning true stops polling immediately. */
  abortIf?: () => boolean | Promise<boolean>;
  /** Injectable for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ReadinessResult {
  ready: boolean;
  attempts: number;
  elapsedMs: number;
  /** HTTP status observed, when the server answered at all. */
  status?: number;
  /**
   * Whether the status matched the plan's expectedStatusCodes.
   *
   * A displayed hint, never a gate. An app redirecting / to /login returns 302 and an
   * API with no root route returns 404 — both are running perfectly well.
   */
  healthHintOk?: boolean;
  lastError?: string;
  /**
   * The start of the body, when the status was not one the plan expected.
   *
   * Bounded and read only on an unexpected status: a body is untrusted application
   * output, and the point is a line a person can read, not a payload to process.
   */
  body?: string;
  /** True when polling stopped because the container had already exited. */
  abortedEarly?: boolean;
}

/** 1s, 2s, 4s, then 8s repeating — bounded so a slow start does not poll hot. */
export function backoffDelays(): number[] {
  return [1_000, 2_000, 4_000, 8_000];
}

function delayForAttempt(attempt: number): number {
  const ladder = backoffDelays();
  return ladder[Math.min(attempt, ladder.length - 1)]!;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Poll an application until it responds.
 *
 * Readiness means the server completed an HTTP response — *any* status, including
 * 3xx, 4xx and 5xx. Only a transport-level failure (connection refused, reset, or a
 * request timeout) counts as not-yet-ready. Anything else would fail healthy apps.
 */
export class ReadinessChecker {
  async waitForReady(opts: ReadinessOptions): Promise<ReadinessResult> {
    const now = opts.now ?? (() => Date.now());
    const sleep = opts.sleep ?? defaultSleep;
    const host = opts.host ?? '127.0.0.1';
    const url = `${opts.protocol ?? 'http'}://${host}:${opts.port}${opts.healthCheck.path}`;

    const started = now();
    let attempts = 0;
    let lastError: string | undefined;

    for (;;) {
      if (await opts.abortIf?.()) {
        return {
          ready: false,
          attempts,
          elapsedMs: now() - started,
          lastError: lastError ?? 'container exited before becoming ready',
          abortedEarly: true,
        };
      }

      const remaining = opts.timeoutMs - (now() - started);
      if (remaining <= 0) {
        return { ready: false, attempts, elapsedMs: now() - started, lastError };
      }

      attempts++;
      try {
        const res =
          opts.protocol === 'https'
            ? await httpsProbe(url, opts.healthCheck.method, Math.min(10_000, remaining))
            : await fetch(url, {
                method: opts.healthCheck.method,
                redirect: 'manual', // A 302 is an answer, not something to follow.
                // Never outlive the budget: a request started near the deadline must not
                // extend the total wait past what the caller asked for.
                signal: AbortSignal.timeout(Math.min(10_000, remaining)),
              });

        const healthHintOk = opts.healthCheck.expectedStatusCodes.includes(res.status);
        return {
          ready: true,
          attempts,
          elapsedMs: now() - started,
          status: res.status,
          healthHintOk,
          // Only when the answer is not a success, and only the first line of it. A 403
          // is inscrutable on its own; `{"detail":"HTTPS is required for all requests."}`
          // is the whole explanation, and the server volunteered it.
          ...(healthHintOk ? {} : { body: await firstLine(res) }),
        };
      } catch (err) {
        lastError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      }

      const elapsed = now() - started;
      const wait = delayForAttempt(attempts - 1);
      if (elapsed + wait >= opts.timeoutMs) {
        return { ready: false, attempts, elapsedMs: elapsed, lastError };
      }
      await sleep(wait);
    }
  }
}

/**
 * The part of a response a person can read, bounded. Never throws: this is a hint.
 *
 * The first line of an HTML error page is `<!doctype html>`, which is what this
 * returned at first and tells nobody anything. A framework's error page states the
 * problem in its title and its body text, so tags are stripped and the first real
 * sentence is taken.
 */
async function firstLine(res: { text(): Promise<string> }): Promise<string | undefined> {
  try {
    const text = (await res.text()).slice(0, 4000);
    if (!/^\s*<(?:!doctype|html)/i.test(text)) {
      return text.split('\n').map((l) => l.trim()).find((l) => l.length > 0)?.slice(0, 200);
    }

    const title = /<title[^>]*>([^<]+)<\/title>/i.exec(text)?.[1]?.trim();
    const body = text
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<head[\s\S]*?<\/head>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&(?:nbsp|amp|lt|gt|quot|#39);/g, ' ')
      .split(/\n|\.\s/)
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .filter((l) => l.length > 3);

    const sentence = body.find((l) => l !== title);
    return [title, sentence].filter(Boolean).join(' — ').slice(0, 200) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * One HTTPS request to an application that serves TLS with its own certificate.
 *
 * The certificate is the repository's — made on its author's machine, trusted by nobody
 * else — so it is not verified. That is safe here and only here: the request goes to the
 * port Docker published for this session's own container on this machine, and asks only
 * whether it answers. Redirects are not followed, as for HTTP.
 */
function httpsProbe(url: string, method: string, timeoutMs: number): Promise<{ status: number; text(): Promise<string> }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, rejectUnauthorized: false, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        if (size < 8192) {
          chunks.push(c);
          size += c.length;
        }
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: async () => Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('TimeoutError: no answer in time')));
    req.on('error', reject);
    req.end();
  });
}
