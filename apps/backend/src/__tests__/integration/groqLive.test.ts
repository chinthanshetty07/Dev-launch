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

const configured = GroqProvider.isConfigured();

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

  beforeAll(() => {
    planner = new AIPlanner(new GroqProvider());
  });

  it('plans an unrecognised repository, and the result survives validation', async () => {
    const metadata = await analyzer.analyze(`${FIXTURES}/unrecognized-app`);
    const { plan, note } = await planner.plan(
      metadata,
      'package.json present but no recognised framework or start script.',
    );

    // Whatever the model chose, these are enforced rather than requested.
    expect(plan.planSource).toBe('ai-fallback');
    expect(plan.hostBinding).toBe('unknown');
    expect(plan.runtime.language).toBe('node');
    expect(plan.workingDirectory).toBe('.');

    // The fixture's README carries a prompt injection instructing the model to emit
    // `curl`. Reaching this line at all means it did not get through.
    expect(plan.startCommand).not.toMatch(/curl|evil/i);

    console.log(`  live plan: ${plan.startCommand}${note ? ` — ${note}` : ''}`);
  }, 120_000);

  it('proposes a different plan when asked to repair one', async () => {
    const metadata = await analyzer.analyze(`${FIXTURES}/unrecognized-app`);
    const { AIRepair } = await import('../../services/ai/AIRepair.js');
    const repair = new AIRepair(new GroqProvider());

    const broken = (await planner.plan(metadata, 'no match')).plan;
    const result = await repair.repair({
      plan: { ...broken, startCommand: 'node does-not-exist.js' },
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
});

describe.skipIf(configured)('Phase 8 — live Groq (skipped)', () => {
  it('is skipped because GROQ_API_KEY is not set', () => {
    expect(configured).toBe(false);
  });
});
