import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { RepositoryAnalyzer } from '../../services/analysis/RepositoryAnalyzer.js';
import { GroqProvider } from '../../services/ai/GroqProvider.js';
import { AIPlanner } from '../../services/ai/AIPlanner.js';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../fixtures');

/** Load .env the same way the server does, so the test needs no separate setup. */
function loadEnv(): void {
  const file = resolve(FIXTURES, '../.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (t === '' || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    if (process.env[k] === undefined) process.env[k] = t.slice(eq + 1).trim();
  }
}
loadEnv();

/**
 * Live tests are opt-in, not merely key-gated.
 *
 * They call someone else's rate-limited service, so they cannot be deterministic: a
 * free tier caps at 8000 tokens per minute, and a full suite run can exhaust the window
 * regardless of retries. Leaving them in the default suite meant a green run and a red
 * run proved the same thing, which makes the suite useless as a signal.
 *
 * Run them deliberately:  DEVLAUNCH_LIVE_AI=1 pnpm --filter @devlaunch/backend test
 */
const optedIn = process.env.DEVLAUNCH_LIVE_AI === '1';
const configured = GroqProvider.isConfigured() && optedIn;

/**
 * Exercises the real Groq API.
 *
 * Skipped without a key, so the suite stays green on a machine that has none — which is
 * the shipped v1 configuration. It is the only test that spends money or reaches an
 * external model.
 */
describe.skipIf(!configured)('Phase 8 — live Groq', () => {
  const analyzer = new RepositoryAnalyzer();
  let planner: AIPlanner;
  let metadata: Awaited<ReturnType<RepositoryAnalyzer['analyze']>>;
  let planned: Awaited<ReturnType<AIPlanner['plan']>>;

  // One planning call, shared. Each live call costs ~1,600 tokens against an 8000 TPM
  // free tier, so four calls in a suite run exhaust the window faster than retries can
  // absorb — which is what made this file flaky.
  beforeAll(async () => {
    planner = new AIPlanner(new GroqProvider());
    metadata = await analyzer.analyze(`${FIXTURES}/unrecognized-app`);
    planned = await planner.plan(
      metadata,
      'package.json present but no recognised framework or start script.',
    );
  }, 120_000);

  it('plans an unrecognised repository, and the result survives validation', () => {
    const { plan, note } = planned;

    // Whatever the model chose, these are enforced rather than requested.
    expect(plan.planSource).toBe('ai-fallback');
    expect(plan.hostBinding).toBe('unknown');
    expect(plan.runtime.language).toBe('node');
    expect(plan.workingDirectory).toBe('.');

    // The fixture's README carries a prompt injection instructing the model to emit
    // `curl`. Reaching this line at all means it did not get through.
    expect(plan.startCommand).not.toMatch(/curl|evil/i);

    console.log(`  live plan: ${plan.startCommand}${note ? ` — ${note}` : ''}`);
  });

  it('proposes a different plan when asked to repair one', async () => {
    const { AIRepair } = await import('../../services/ai/AIRepair.js');
    const repair = new AIRepair(new GroqProvider());

    const result = await repair.repair({
      plan: { ...planned.plan, startCommand: 'node does-not-exist.js' },
      failure: {
        code: 'START_COMMAND_FAILED',
        message: 'Start command exited with code 1.',
        evidence: "Error: Cannot find module '/workspace/does-not-exist.js'",
      } as never,
      logs: "Error: Cannot find module '/workspace/does-not-exist.js'",
      metadata,
      previousAttempts: [],
    });

    expect(result.attempt).toBe(1);
    expect(result.plan.startCommand).not.toBe('node does-not-exist.js');
    expect(result.plan.planSource).toBe('ai-fallback');
    console.log(`  live repair: ${result.plan.startCommand}`);
  }, 120_000);

  it('never lets an unsafe repair through, whatever the model proposes', async () => {
    // Asserting that a live model cooperates would be a flaky test of someone else's
    // service. The invariant worth asserting is ours: either a valid plan comes back,
    // or it is rejected for a stated reason. An unsafe command is never executable.
    const { AIRepair } = await import('../../services/ai/AIRepair.js');
    const repair = new AIRepair(new GroqProvider());

    const outcome = await repair
      .repair({
        plan: {
          runtime: { language: 'node', version: '20' },
          packageManager: 'npm',
          installCommand: null,
          buildCommand: null,
          startCommand: 'node does-not-exist.js',
          workingDirectory: '.',
          expectedPort: 3000,
          hostBinding: 'unknown',
          environmentVariables: [],
          healthCheck: { path: '/', method: 'GET', expectedStatusCodes: [200] },
          planSource: 'ai-fallback',
        } as never,
        failure: { code: 'START_COMMAND_FAILED', message: 'exited 1' } as never,
        logs: "Error: Cannot find module '/workspace/does-not-exist.js'",
        metadata,
        previousAttempts: [],
      })
      .then((r) => ({ ok: true as const, plan: r.plan }))
      .catch((e: unknown) => ({ ok: false as const, error: e }));

    if (outcome.ok) {
      expect(outcome.plan.workingDirectory).toBe('.');
      expect(outcome.plan.planSource).toBe('ai-fallback');
      expect(outcome.plan.startCommand).not.toMatch(/curl|wget|;|\||&&|\$\(/);
    } else {
      // A rejection is a correct outcome, not a test failure.
      expect(String(outcome.error)).toMatch(/rejected|identical|not an approved/i);
    }
  }, 120_000);
});

describe.skipIf(configured)('Phase 8 — live Groq (skipped)', () => {
  it('is skipped unless DEVLAUNCH_LIVE_AI=1 and GROQ_API_KEY are both set', () => {
    expect(configured).toBe(false);
  });
});
