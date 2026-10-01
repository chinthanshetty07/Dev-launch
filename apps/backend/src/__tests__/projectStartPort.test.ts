import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { RepositoryAnalyzer } from '../services/analysis/RepositoryAnalyzer.js';
import { RuleBasedPlanner } from '../services/planning/RuleBasedPlanner.js';
import { ProjectPlanner, withStartPort } from '../services/planning/ProjectPlanner.js';

const scratch: string[] = [];
afterAll(async () => {
  await Promise.all(scratch.map((d) => rm(d, { recursive: true, force: true }).catch(() => undefined)));
});
async function repo(files: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'devlaunch-port-'));
  scratch.push(root);
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), typeof contents === 'string' ? contents : JSON.stringify(contents));
  }
  return root;
}

describe("moving a start command's port flag", () => {
  it('moves the flags DevLaunch writes, in each form', () => {
    expect(withStartPort('npm run dev -- --host 0.0.0.0 --port 5173', 5173, 3000)).toBe('npm run dev -- --host 0.0.0.0 --port 3000');
    expect(withStartPort('npm run dev -- --port=5173', 5173, 3000)).toBe('npm run dev -- --port=3000');
    expect(withStartPort('npm run dev -- -H 0.0.0.0 -p 3000', 3000, 3001)).toBe('npm run dev -- -H 0.0.0.0 -p 3001');
  });

  it('leaves everything else alone', () => {
    expect(withStartPort('npm run dev', 5173, 3000)).toBe('npm run dev');
    expect(withStartPort('npm run dev -- --port 51730', 5173, 3000)).toBe('npm run dev -- --port 51730');
    expect(withStartPort('npm run dev -- --port 5173', 5173, 5173)).toBe('npm run dev -- --port 5173');
    expect(withStartPort('npm run dev -- --port 5173', null, 3000)).toBe('npm run dev -- --port 5173');
  });
});

describe('a project whose frontend declares its own port (niksbanna/mern-boilerplate)', () => {
  it('starts the frontend on the port it is watched on', async () => {
    // Its compose file publishes the client on 3000 (so does vite.config.ts). The plan moved to 3000 and kept
    // `--port 5173`, which Vite obeys over its config: it listened on 5173 while DevLaunch
    // watched 3000, and the client was reported as failing to start.
    const root = await repo({
      'client/package.json': { name: 'client', scripts: { dev: 'vite' }, devDependencies: { vite: '^5' } },
      'client/vite.config.ts': "import { defineConfig } from 'vite';\nexport default defineConfig({ server: { port: 3000 } });\n",
      'client/index.html': '<div id="root"></div>',
      'server/package.json': { name: 'server', scripts: { dev: 'node src/server.js' }, dependencies: { express: '^4' } },
      'server/src/server.js': "const express = require('express');\nconst PORT = process.env.PORT || 5000;\nexpress().listen(PORT);\n",
      // Where the port came from in the real repository: its compose file.
      'docker-compose.yml': [
        'services:',
        '  server:',
        '    build: ./server',
        "    ports: ['5000:5000']",
        '  client:',
        '    build: ./client',
        "    ports: ['3000:3000']",
        '',
      ].join('\n'),
    });
    const analyzer = new RepositoryAnalyzer();
    const meta = await analyzer.analyze(root);
    const out = await new ProjectPlanner(analyzer, new RuleBasedPlanner(analyzer)).planProject(root, meta as never);
    const client = out.plan?.services.find((s) => s.workingDirectory === 'client');
    expect(client?.expectedPort).toBe(3000);
    expect(client?.startCommand).toMatch(/--port 3000\b/);
    expect(client?.startCommand).not.toMatch(/5173/);
  });
});
