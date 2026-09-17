import type { HealthCheck } from '@devlaunch/shared';

export interface ReadinessOptions {
  host?: string;
  port: string | number;
  healthCheck: HealthCheck;
  timeoutMs: number;
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
    const url = `http://${host}:${opts.port}${opts.healthCheck.path}`;

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
        const res = await fetch(url, {
          method: opts.healthCheck.method,
          redirect: 'manual', // A 302 is an answer, not something to follow.
          // Never outlive the budget: a request started near the deadline must not
          // extend the total wait past what the caller asked for.
          signal: AbortSignal.timeout(Math.min(10_000, remaining)),
        });

        return {
          ready: true,
          attempts,
          elapsedMs: now() - started,
          status: res.status,
          healthHintOk: opts.healthCheck.expectedStatusCodes.includes(res.status),
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
