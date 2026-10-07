import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDockerSocket } from '../config/index.js';

/**
 * DevLaunch runs on other people's computers, with whatever Docker they have: Colima,
 * Docker Desktop, OrbStack, or Docker Engine on Linux.
 */

describe('finding Docker', () => {
  const none = () => null;
  const nothing = () => false;

  it('uses DOCKER_HOST when it is set', () => {
    expect(resolveDockerSocket({ DOCKER_HOST: 'unix:///custom/docker.sock' }, none, nothing)).toBe('/custom/docker.sock');
  });

  it('uses the engine the docker command is using, so it matches the person\'s own terminal', () => {
    const ctx = () => 'unix:///Users/someone/.orbstack/run/docker.sock';
    expect(resolveDockerSocket({}, ctx, (p) => p === '/Users/someone/.orbstack/run/docker.sock'))
      .toBe('/Users/someone/.orbstack/run/docker.sock');
  });

  it('ignores a context whose socket is not there, and looks in each engine\'s usual place', () => {
    const ctx = () => 'unix:///gone/docker.sock';
    const desktop = join(homedir(), '.docker', 'run', 'docker.sock');
    expect(resolveDockerSocket({}, ctx, (p) => p === desktop)).toBe(desktop);
    expect(resolveDockerSocket({}, none, (p) => p === '/var/run/docker.sock')).toBe('/var/run/docker.sock');
  });

  it('says how to start Docker on any engine when there is none', () => {
    expect(() => resolveDockerSocket({}, none, nothing)).toThrow(/Docker Desktop, OrbStack or Colima/);
  });
});

describe('advice for any engine', () => {
  // Every user-facing string that tells someone to run a Colima command must also say what
  // to do on Docker Desktop — a person on Linux or Docker Desktop cannot act on it otherwise.
  const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      if (n === '__tests__') return [];
      return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
    });

  it('never gives a Colima-only command', () => {
    const offenders: string[] = [];
    for (const file of files(SRC)) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        const code = line.trim();
        if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*')) return;
        if (/['"`][^'"`]*colima (start|stop|status|ssh)/i.test(line) && !/Docker Desktop/.test(line)) {
          offenders.push(`${file.slice(SRC.length + 1)}:${i + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
