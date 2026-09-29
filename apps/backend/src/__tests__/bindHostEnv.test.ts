import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findBindHostVariable } from '../services/analysis/ServiceDiscovery.js';
import { RuleBasedPlanner } from '../services/planning/RuleBasedPlanner.js';
import { RepositoryAnalyzer } from '../services/analysis/RepositoryAnalyzer.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'devlaunch-bindenv-'));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    await mkdir(join(dir, name, '..'), { recursive: true });
    await writeFile(join(dir, name), body);
  }
  return dir;
}

describe('the variable an application binds by', () => {
  it('finds it in a listen options object, across lines', async () => {
    const dir = await repo({
      'src/server.ts': [
        'void server.listen({',
        '  port: Number(process.env.PORT ?? 3000),',
        "  host: process.env.SERVER_HOSTNAME ?? '127.0.0.1',",
        '})',
      ].join('\n'),
    });
    expect(await findBindHostVariable(dir)).toEqual({ key: 'SERVER_HOSTNAME', file: 'src/server.ts' });
  });

  it('finds it as the second positional argument', async () => {
    const dir = await repo({ 'app.js': 'app.listen(port, process.env.BIND_ADDR, () => {});' });
    expect((await findBindHostVariable(dir))?.key).toBe('BIND_ADDR');
  });

  it('finds it through a host constant the call is given', async () => {
    const dir = await repo({
      'index.js': "const hostname = process.env.APP_HOST || 'localhost';\nserver.listen(3000, hostname);",
    });
    expect((await findBindHostVariable(dir))?.key).toBe('APP_HOST');
  });

  it('ignores HOST, which DevLaunch already sets', async () => {
    const dir = await repo({ 'server.js': 'server.listen({ port, host: process.env.HOST })' });
    expect(await findBindHostVariable(dir)).toBeUndefined();
  });

  it('never takes a variable the listen call does not use', async () => {
    // A database host is also `process.env.X` with a loopback default. Pointing it at
    // 0.0.0.0 would break the one thing that worked.
    const dir = await repo({
      'server.js': [
        "const host = process.env.DB_HOST || 'localhost';",
        'db.connect({ host });',
        'app.listen(process.env.PORT);',
      ].join('\n'),
    });
    expect(await findBindHostVariable(dir)).toBeUndefined();
  });

  it('does not call the default of a bind variable a hardcoded bind', async () => {
    const dir = await repo({
      'package.json': JSON.stringify({ scripts: { start: 'node server.js' } }),
      'server.js': "server.listen({ port: 3000, host: process.env.SERVER_HOSTNAME ?? '127.0.0.1' })",
    });
    const meta = await new RepositoryAnalyzer().analyze(dir);
    expect(meta.hardcodedBind).toBeUndefined();
    expect(meta.bindHostEnv?.key).toBe('SERVER_HOSTNAME');
  });

  it('plans the variable beside HOST', async () => {
    const dir = await repo({
      'package.json': JSON.stringify({ scripts: { start: 'node server.js' } }),
      'server.js': "server.listen({ port: 3000, host: process.env.SERVER_HOSTNAME ?? '127.0.0.1' })",
    });
    const outcome = await new RuleBasedPlanner(new RepositoryAnalyzer()).planRepository(dir);
    const env = Object.fromEntries(outcome.plan!.environmentVariables.map((v) => [v.key, v.value]));
    expect(env).toMatchObject({ HOST: '0.0.0.0', SERVER_HOSTNAME: '0.0.0.0' });
  });

  it('plans it for a framework started from its entry file, too', async () => {
    // No start script: `node app.js` is planned from the entry file, on a separate path.
    const dir = await repo({
      'package.json': JSON.stringify({ dependencies: { express: '^4.0.0' } }),
      'app.js': "app.listen(3000, process.env.BIND_ADDR || '127.0.0.1');",
    });
    const outcome = await new RuleBasedPlanner(new RepositoryAnalyzer()).planRepository(dir);
    expect(outcome.plan?.startCommand).toBe('node app.js');
    const env = Object.fromEntries(outcome.plan!.environmentVariables.map((v) => [v.key, v.value]));
    expect(env.BIND_ADDR).toBe('0.0.0.0');
  });
});
