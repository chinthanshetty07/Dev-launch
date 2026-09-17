import { FailureCode } from '@devlaunch/shared';
import { SecurityRejection } from '../security/ImageAllowlist.js';
import type { AIProvider, PlanRequest, RepairRequest } from './AIProvider.js';
import { planPrompt, repairPrompt, systemPrompt } from './prompts.js';

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
/**
 * Groq's catalogue changes; this is verified against a live account rather than
 * assumed. Override with GROQ_MODEL, and list what an account can actually reach at
 * https://api.groq.com/openai/v1/models.
 */
const DEFAULT_MODEL = 'openai/gpt-oss-120b';

export interface GroqOptions {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  /** Retries on HTTP 429. Rate limits are normal operation, not an exceptional failure. */
  maxRetries?: number;
  /** Injectable for tests, so no network is required to exercise the parsing path. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * How long to wait before retrying a rate-limited request.
 *
 * Groq sends `retry-after`, and also states the delay in the error message. Both are
 * preferred over a guess, because the server knows when the window actually resets.
 */
export function retryDelayMs(res: Response, body: string, attempt: number): number {
  const header = Number(res.headers.get('retry-after'));
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1000 + 250, 30_000);

  const stated = /try again in ([\d.]+)s/i.exec(body);
  if (stated) return Math.min(Number(stated[1]) * 1000 + 250, 30_000);

  return Math.min(1000 * 2 ** attempt, 30_000);
}

export class AIUnavailable extends Error {}

/**
 * Groq-backed provider.
 *
 * Chosen for latency and cost: the AI path here is deliberately narrow — 22
 * deterministic detectors mean the fallback planner fires rarely, and the repair loop
 * is capped at two attempts — so a fast, cheap model suits the shape of the workload.
 *
 * The key is read at call time rather than module load so it can be added without a
 * restart, and it is never logged, echoed, or included in an error message.
 */
export class GroqProvider implements AIProvider {
  readonly name = 'groq';

  constructor(private readonly opts: GroqOptions = {}) {}

  static isConfigured(): boolean {
    return Boolean(process.env.GROQ_API_KEY?.trim());
  }

  private key(): string {
    const key = this.opts.apiKey ?? process.env.GROQ_API_KEY?.trim();
    if (!key) {
      throw new AIUnavailable(
        'GROQ_API_KEY is not set. DevLaunch plans deterministically without it.',
      );
    }
    return key;
  }

  async generateRunPlan(request: PlanRequest): Promise<unknown> {
    return this.complete(planPrompt(request.metadata, request.ruleBasedReason));
  }

  async diagnoseFailure(request: RepairRequest): Promise<unknown> {
    return this.complete(
      repairPrompt(request.plan, request.failure, request.logs, request.previousAttempts),
    );
  }

  private async complete(userPrompt: string): Promise<unknown> {
    const key = this.key();
    const model = this.opts.model ?? process.env.GROQ_MODEL ?? DEFAULT_MODEL;
    const doFetch = this.opts.fetchImpl ?? fetch;

    // A free tier resets its token budget once a minute, and the server states how
    // long to wait. Five retries at server-stated (capped) delays covers a full window;
    // three did not, which made the suite non-deterministic under load.
    const maxRetries = this.opts.maxRetries ?? 5;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

    for (let attempt = 0; ; attempt++) {
      const res = await this.request(doFetch, key, model, userPrompt);

      // A rate limit is a "wait", not a "no". Groq states how long to wait, so the
      // delay comes from the server rather than from a guess.
      if (res.status === 429 && attempt < maxRetries) {
        const body = await res.text().catch(() => '');
        await sleep(retryDelayMs(res, body, attempt));
        continue;
      }

      return this.parse(res, model);
    }
  }

  private async request(
    doFetch: typeof fetch,
    key: string,
    model: string,
    userPrompt: string,
  ): Promise<Response> {
    try {
      return await doFetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model,
          // Structured output: a prose answer cannot be validated or executed.
          response_format: { type: 'json_object' },
          // Planning is inference, not invention; low temperature keeps it close to
          // the evidence it was given.
          temperature: 0.1,
          max_tokens: 1200,
          messages: [
            { role: 'system', content: systemPrompt() },
            { role: 'user', content: userPrompt },
          ],
        }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
      });
    } catch (err) {
      throw new AIUnavailable(
        `Could not reach Groq: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async parse(res: Response, model: string): Promise<unknown> {
    if (!res.ok) {
      // The body may echo request content; the key is never in it, and is never logged.
      const detail = await res.text().catch(() => '');
      const hint =
        res.status === 401
          ? ' (check GROQ_API_KEY)'
          : res.status === 404
            ? ` (model "${model}" unavailable; set GROQ_MODEL to one this account can reach)`
            : res.status === 429
              ? ' (rate limited, and retries were exhausted)'
              : '';
      throw new AIUnavailable(`Groq returned ${res.status}${hint}: ${detail.slice(0, 300)}`);
    }

    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = body.choices?.[0]?.message?.content;
    if (!content) {
      throw new SecurityRejection(
        FailureCode.INVALID_AI_PLAN,
        'Groq returned no content.',
      );
    }

    try {
      return JSON.parse(content);
    } catch {
      throw new SecurityRejection(
        FailureCode.INVALID_AI_PLAN,
        `Groq returned output that is not valid JSON: ${content.slice(0, 200)}`,
      );
    }
  }
}
