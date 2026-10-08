import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { RepositoryAnalyzer } from '../services/analysis/RepositoryAnalyzer.js';

/**
 * A compose file names services but says nothing about roles, so its role is a guess; the
 * service's own dependencies are evidence. The guess used to win.
 */
describe('a role read from dependencies, against a compose file\'s guess', () => {
  it('keeps the React app the page even when something else depends on it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'devlaunch-role-'));
    const write = (p: string, body: string) => {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), body);
    };
    write('frontend/package.json', JSON.stringify({ name: 'web', scripts: { start: 'react-scripts start' }, dependencies: { react: '18', 'react-dom': '18', 'react-scripts': '5' } }));
    write('backend/manage.py', 'import os\n');
    write('backend/requirements.txt', 'Django>=5\n');
    // An end-to-end test service depends on the frontend: compose's guess calls it an API.
    write('docker-compose.yml', [
      'services:',
      '  spa:', '    build: ./frontend', '    ports: ["3000:3000"]',
      '  api:', '    build: ./backend', '    ports: ["8000:8000"]',
      '  e2e:', '    image: cypress/included', '    depends_on: [spa]', '    ports: ["9000:9000"]',
      '',
    ].join('\n'));
    const meta = await new RepositoryAnalyzer().analyze(root);
    const roles = Object.fromEntries((meta.services ?? []).map((s) => [s.dir, s.role]));
    expect(roles.frontend).toBe('web');
    expect(roles.backend).toBe('api');
  });
});
