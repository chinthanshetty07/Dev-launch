import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, cp } from 'node:fs/promises';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RepositoryAnalyzer } from '../services/analysis/RepositoryAnalyzer.js';
import { RuleBasedPlanner } from '../services/planning/RuleBasedPlanner.js';
import { RunPlanValidator } from '../services/planning/RunPlanValidator.js';
import { ReadinessChecker } from '../services/readiness/ReadinessChecker.js';
import { selfSignedCert } from './helpers/selfSignedCert.js';
import { ExecutionState, RunPlanSchema } from '@devlaunch/shared';
import { SessionManager } from '../services/session/SessionManager.js';
import type { ExecutionManager, LaunchHandle, ReadyOutcome } from '../services/execution/ExecutionManager.js';
import { LogManager } from '../services/logs/LogManager.js';

/**
 * An application that refuses plain HTTP, served the way its README serves it — over TLS
 * with certificate files it ships (`nkwus/fastapi-starter`). Served for real in
 * `integration/pipeline.test.ts`.
 */
const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../fixtures/python-fastapi-https');
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function copyFixture(readme?: string) {
  const d = await mkdtemp(join(tmpdir(), 'devlaunch-https-'));
  dirs.push(d);
  await cp(FIXTURE, d, { recursive: true });
  if (readme !== undefined) await writeFile(join(d, 'README.md'), readme);
  return d;
}
const analyzer = new RepositoryAnalyzer();

describe('the certificate a README serves with', () => {
  it('is found when the README starts uvicorn with it and both files are there', async () => {
    const d = await copyFixture();
    await selfSignedCert(join(d, 'certs'));
    const meta = await analyzer.analyze(d);
    expect(meta.tls).toMatchObject({ certFile: 'certs/localhost.pem', keyFile: 'certs/localhost-key.pem' });
  });

  it('is not believed when the files are missing', async () => {
    const d = await copyFixture();
    expect((await analyzer.analyze(d)).tls).toBeUndefined();
  });

  it('is never a path outside the repository, or an unusual one — even when the file is there', async () => {
    // Each file really exists where the path points, so only the path check can refuse it.
    for (const cert of ['../outside.pem', 'certs/a.pem;rm', '-rf.pem']) {
      const d = await copyFixture(`uvicorn main:app --ssl-certfile ${cert} --ssl-keyfile k.pem\n`);
      await writeFile(join(d, 'k.pem'), 'key');
      const { mkdir } = await import('node:fs/promises');
      await mkdir(dirname(join(d, cert)), { recursive: true });
      await writeFile(join(d, cert), 'cert');
      dirs.push(resolve(d, cert)); // `../outside.pem` lands beside the copy; remove it too
      expect((await analyzer.analyze(d)).tls, cert).toBeUndefined();
    }
  });
});

describe('a FastAPI plan for it', () => {
  it('serves over HTTPS with those files, says so, and passes the validator', async () => {
    const d = await copyFixture();
    await selfSignedCert(join(d, 'certs'));
    const out = await new RuleBasedPlanner(analyzer).planRepository(d);
    expect(out.plan?.protocol).toBe('https');
    expect(out.plan?.startCommand).toBe(
      'uvicorn main:app --host 0.0.0.0 --port 8000 --ssl-certfile certs/localhost.pem --ssl-keyfile certs/localhost-key.pem',
    );
    expect(out.warnings.join(' ')).toMatch(/Served over HTTPS[\s\S]*not private[\s\S]*Advanced, then Proceed/);
    expect(() => new RunPlanValidator().validate({ plan: out.plan! })).not.toThrow();
  });

  it('is plain HTTP without them', async () => {
    const d = await copyFixture();
    const out = await new RuleBasedPlanner(analyzer).planRepository(d);
    expect(out.plan?.protocol).toBeUndefined();
    expect(out.plan?.startCommand).not.toMatch(/ssl/);
  });
});

describe('waiting for an HTTPS application', () => {
  it('reaches it through its own untrusted certificate', async () => {
    const d = await mkdtemp(join(tmpdir(), 'devlaunch-https-srv-'));
    dirs.push(d);
    const { certPath, keyPath } = await selfSignedCert(d);
    const server = createServer({ cert: await readFile(certPath), key: await readFile(keyPath) }, (_q, r) => r.end('ok'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const port = (server.address() as AddressInfo).port;
      const healthCheck = { path: '/', method: 'GET' as const, expectedStatusCodes: [200] };
      const https = await new ReadinessChecker().waitForReady({ port, healthCheck, timeoutMs: 5000, protocol: 'https' });
      expect(https).toMatchObject({ ready: true, status: 200, healthHintOk: true });
      // Asked over plain HTTP, a TLS server never answers as one: that is the bug this fixes.
      const http = await new ReadinessChecker().waitForReady({ port, healthCheck, timeoutMs: 1500 });
      expect(http.ready).toBe(false);
    } finally {
      server.close();
    }
  });
});

describe('a project whose API serves HTTPS', () => {
  it('tells the frontend to call it over https, from the browser and from inside', async () => {
    const env: Record<string, Record<string, string | null>> = {};
    const ready: ReadyOutcome = {
      state: ExecutionState.READY, hostPort: '1', url: 'http://localhost:1',
      readiness: { ready: true, attempts: 1, elapsedMs: 1 } as ReadyOutcome['readiness'],
    };
    const exec = {
      docker: { networkExists: async () => true, claimedAliases: async () => new Set<string>() },
      async launch(o: { plan: { name: string; environmentVariables: { key: string; value: string | null }[] }; logs?: LogManager }) {
        env[o.plan.name] = Object.fromEntries(o.plan.environmentVariables.map((v) => [v.key, v.value]));
        return {
          container: { id: o.plan.name }, logs: o.logs ?? new LogManager(), waitForReady: async () => ready,
          liveness: async () => ({ kind: 'running' }), clearStartupBudget: () => undefined, cleanup: async () => ({ errors: [] }),
        } as unknown as LaunchHandle;
      },
    } as unknown as ExecutionManager;
    const plan = (name: string, role: string, port: number, extra: Record<string, unknown> = {}) => ({
      ...RunPlanSchema.parse({
        runtime: { language: 'node', version: '20' }, packageManager: 'npm', installCommand: null, buildCommand: null,
        startCommand: 'npm run dev', workingDirectory: name, expectedPort: port, planSource: 'rule-based', ...extra,
      }),
      name, role,
    });
    const m = new SessionManager(exec, {
      analyzer: { analyze: async () => ({ warnings: [], envExample: [], lockfiles: [], frameworkConfigs: [], services: [
        { name: 'api', dir: 'api', role: 'api', language: 'python', scripts: [], evidence: 'x' },
        { name: 'web', dir: 'web', role: 'web', language: 'node', scripts: [], evidence: 'x', envKeys: ['VITE_API_URL', 'API_URL'] },
      ] }) } as never,
      planner: { planRepository: async () => ({ plan: null, warnings: [] }) } as never,
      projectPlanner: { planProject: async () => ({
        plan: { services: [plan('api', 'api', 8000, { protocol: 'https' }), plan('web', 'web', 5173)], planSource: 'rule-based' },
        skipped: [], warnings: [],
      }) } as never,
    });
    const s = await m.launch({ sourceDir: '/tmp/https-project' });
    for (let i = 0; i < 200 && !env.web; i++) await new Promise((r) => setTimeout(r, 20));
    await m.shutdown();
    void s;
    expect(env.web?.VITE_API_URL).toMatch(/^https:\/\/localhost:\d+$/);
    expect(env.web?.API_URL).toBe('https://api:8000');
  });
});
