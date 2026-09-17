import { FailureCode } from '@devlaunch/shared';
import { SecurityRejection } from '../security/ImageAllowlist.js';
import type { AIProvider, PlanRequest, RepairRequest } from './AIProvider.js';
import { planPrompt, repairPrompt, systemPrompt } from './prompts.js';

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = 'llama-3.3-70b-versatile';

export interface GroqOptions {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  /** Injectable for tests, so no network is required to exercise the parsing path. */
  fetchImpl?: typeof fetch;
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

    let res: Response;
    try {
      res = await doFetch(ENDPOINT, {
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

    if (!res.ok) {
      // The body may echo request content; the key is never in it, and is never logged.
      const detail = await res.text().catch(() => '');
      throw new AIUnavailable(
        `Groq returned ${res.status}${res.status === 401 ? ' (check GROQ_API_KEY)' : ''}: ` +
          detail.slice(0, 300),
      );
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
