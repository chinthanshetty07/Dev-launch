import { describe, it, expect } from 'vitest';
import { ExecutionState, RunPlanSchema, classifyEnvVar } from '@devlaunch/shared';
import { SessionManager } from '../services/session/SessionManager.js';
import type { ExecutionManager } from '../services/execution/ExecutionManager.js';

describe('what kind of thing a variable is', () => {
  it('tells a self-signing secret, an outside key, another secret and a setting apart', () => {
    expect(classifyEnvVar('JWT_SECRET')).toBe('AUTO_GENERATABLE_VALUE');
    expect(classifyEnvVar('SECRET_KEY')).toBe('AUTO_GENERATABLE_VALUE');
    expect(classifyEnvVar('NEXTAUTH_SECRET')).toBe('AUTO_GENERATABLE_VALUE');
    expect(classifyEnvVar('STRIPE_SECRET_KEY')).toBe('EXTERNAL_SERVICE_REQUIRED');
    expect(classifyEnvVar('OPENAI_API_KEY')).toBe('EXTERNAL_SERVICE_REQUIRED');
    expect(classifyEnvVar('ADMIN_PASSWORD')).toBe('REQUIRED_SECRET');
    expect(classifyEnvVar('MAILER_API_KEY')).toBe('REQUIRED_SECRET');
    expect(classifyEnvVar('DATABASE_URL')).toBe('REQUIRED_CONFIGURATION');
    expect(classifyEnvVar('PORT', true)).toBe('OPTIONAL_CONFIGURATION');
  });
});

function manager(envKeys: string[]) {
  const plan = RunPlanSchema.parse({
    runtime: { language: 'node', version: '20' }, packageManager: 'npm', installCommand: null, buildCommand: null,
    startCommand: 'node s.js', workingDirectory: '.', expectedPort: 3000, planSource: 'rule-based',
  });
  return new SessionManager({} as ExecutionManager, {
    analyzer: { analyze: async () => ({ warnings: [], lockfiles: [], frameworkConfigs: [], envExample: envKeys.map((key) => ({ key, hasDefault: false })) }) } as never,
    planner: { planRepository: async () => ({ plan, detected: 'node', warnings: [] }) } as never,
  });
}

describe('configuration a deployment needs', () => {
  it('generates the secrets an app only signs its own things with, and asks for the rest, labelled', async () => {
    const m = manager(['JWT_SECRET', 'STRIPE_SECRET_KEY', 'ADMIN_EMAIL']);
    const s = await m.launch({ sourceDir: '/tmp/repo', image: 'devlaunch/node:20' });
    for (let i = 0; i < 200 && s.state !== ExecutionState.AWAITING_INPUT; i++) await new Promise((r) => setTimeout(r, 10));
    expect(s.pending?.requiredEnv.map((v) => [v.key, v.kind])).toEqual([
      ['STRIPE_SECRET_KEY', 'EXTERNAL_SERVICE_REQUIRED'],
      ['ADMIN_EMAIL', 'REQUIRED_CONFIGURATION'],
    ]);
    const jwt = s.plan?.environmentVariables.find((v) => v.key === 'JWT_SECRET')?.value;
    expect(jwt).toMatch(/^[0-9a-f]{64}$/);
    const log = s.logs.buffer.all().map((l) => l.text).join('\n');
    expect(log).toMatch(/Generated a random local value for JWT_SECRET/);
    expect(log).not.toContain(jwt!);
    expect(s.events?.find((e) => e.event === 'ENV_GENERATED')?.detail).toBe('JWT_SECRET');
    await m.shutdown();
  });

  it('never invents a key for someone else’s service', async () => {
    const m = manager(['OPENAI_API_KEY']);
    const s = await m.launch({ sourceDir: '/tmp/repo', image: 'devlaunch/node:20' });
    for (let i = 0; i < 200 && s.state !== ExecutionState.AWAITING_INPUT; i++) await new Promise((r) => setTimeout(r, 10));
    expect(s.state).toBe(ExecutionState.AWAITING_INPUT);
    expect(s.plan?.environmentVariables.find((v) => v.key === 'OPENAI_API_KEY')?.value ?? null).toBeNull();
    await m.shutdown();
  });
});

describe('a single application’s missing configuration', () => {
  it('never includes a database address DevLaunch provides (python-flask-basic)', async () => {
    const { requiredConfigurationForSingle } = await import('../services/planning/RequiredConfiguration.js');
    const meta = {
      envExample: [{ key: 'SECRET_KEY', hasDefault: false }, { key: 'DATABASE_URL', hasDefault: false }, { key: 'PORT', hasDefault: true }],
      backing: [{ kind: 'postgres', evidence: 'DATABASE_URL', urlEnvKeys: ['DATABASE_URL'], neededBy: [] }],
    } as never;
    expect(requiredConfigurationForSingle(meta).map((v) => v.key)).toEqual(['SECRET_KEY']);
  });
});
