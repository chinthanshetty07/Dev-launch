import { describe, it, expect } from 'vitest';
import { RunPlanSchema, Sentinel, type RunPlan } from '@devlaunch/shared';
import { buildWrapperScript, buildWrapperEnv } from '../services/docker/wrapper.js';

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

describe('buildWrapperScript', () => {
  it('is byte-identical regardless of the plan', () => {
    // The script is static; only the environment changes. This is what makes command
    // injection into the script body structurally impossible.
    expect(buildWrapperScript()).toBe(buildWrapperScript());
  });

  it('never embeds command text in the script body', () => {
    const script = buildWrapperScript();
    expect(script).not.toContain('npm install');
    expect(script).not.toContain('node server.js');
    expect(script).toContain('$DL_INSTALL_CMD');
    expect(script).toContain('$DL_START_CMD');
  });

  it('emits every phase sentinel', () => {
    const script = buildWrapperScript();
    for (const marker of [
      Sentinel.INSTALL_BEGIN,
      Sentinel.INSTALL_OK,
      Sentinel.INSTALL_FAIL,
      Sentinel.BUILD_BEGIN,
      Sentinel.START_BEGIN,
    ]) {
      expect(script).toContain(marker);
    }
  });

  it('execs the start command so signals reach the application', () => {
    expect(buildWrapperScript()).toContain('exec sh -c "$DL_START_CMD"');
  });
});

describe('buildWrapperEnv', () => {
  it('passes commands as environment variables', () => {
    const env = buildWrapperEnv(plan(), '/workspace');
    expect(env).toContain('DL_INSTALL_CMD=npm install');
    expect(env).toContain('DL_START_CMD=node server.js');
    expect(env).toContain('DL_WORKDIR=/workspace');
  });

  it('defines absent commands as empty strings, because the script uses set -u', () => {
    const env = buildWrapperEnv(plan({ installCommand: null, buildCommand: null }), '/workspace');
    expect(env).toContain('DL_INSTALL_CMD=');
    expect(env).toContain('DL_BUILD_CMD=');
  });

  it('injects PORT and HOST when a port is expected', () => {
    const env = buildWrapperEnv(plan({ expectedPort: 4000 }), '/workspace');
    expect(env).toContain('PORT=4000');
    expect(env).toContain('HOST=0.0.0.0');
  });

  it('lets an explicit plan variable win over the injected default', () => {
    const env = buildWrapperEnv(
      plan({ expectedPort: 4000, environmentVariables: [{ key: 'PORT', value: '9999', required: true }] }),
      '/workspace',
    );
    expect(env).toContain('PORT=9999');
    expect(env).not.toContain('PORT=4000');
  });

  it('transports a command verbatim, leaving rejection to the validator', () => {
    // The wrapper is a transport, not a gate: it carries whatever it is handed. A
    // command like this is rejected upstream by CommandValidator before launch ever
    // reaches the wrapper, which is asserted in CommandValidator.test.ts. Keeping the
    // two layers separate is deliberate — the transport must not silently mangle input.
    const env = buildWrapperEnv(plan({ buildCommand: 'tsc && vite build' }), '/workspace');
    expect(env).toContain('DL_BUILD_CMD=tsc && vite build');
  });
});
