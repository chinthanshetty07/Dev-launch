import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { findCaseMismatches, caseMismatchWarning } from '../services/analysis/CaseImports.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function repo(files: Record<string, string>) {
  const d = await mkdtemp(join(tmpdir(), 'devlaunch-case-'));
  dirs.push(d);
  for (const [p, body] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), body);
  }
  return d;
}

describe('imports that only resolve if letter case is ignored', () => {
  it('are found, with the file, line, import and real name (fakir-tech/typescript-fullstack-monorepo)', async () => {
    const d = await repo({
      'src/app/Responsewidget.tsx': "import React from 'react';\nimport { FeedbackPanel } from \"./feedbackPanel\";\n",
      'src/app/FeedbackPanel.tsx': 'export const FeedbackPanel = () => null;\n',
    });
    expect(await findCaseMismatches(d)).toEqual([
      { file: 'src/app/Responsewidget.tsx', line: 2, imported: './feedbackPanel', actual: 'FeedbackPanel.tsx' },
    ]);
  });

  it('includes directories on the way, require() and dynamic import()', async () => {
    const d = await repo({
      'src/index.js': "const u = require('./Utils/strings');\nconst p = import('./pages/home');\n",
      'src/utils/strings.js': '',
      'src/Pages/Home.jsx': '',
    });
    const found = await findCaseMismatches(d);
    expect(found.map((f) => [f.imported, f.actual])).toEqual([['./Utils/strings', 'utils/strings.js'], ['./pages/home', 'Pages/Home.jsx']]);
  });

  it('says nothing about imports that resolve exactly or not at all, and never reads inside node_modules', async () => {
    // The file inside node_modules has a case-only import of its own; it is not the
    // repository's code and is not scanned.
    const d = await repo({
      'src/a.ts': "import b from './b';\nimport c from './missing';\nimport idx from './lib';\n",
      'src/b.ts': '',
      'src/lib/index.ts': '',
      'node_modules/x/x.js': "import y from './Y';\n",
      'node_modules/x/y.js': '',
    });
    expect(await findCaseMismatches(d)).toEqual([]);
  });

  it('is said in plain words, naming the cause', () => {
    const w = caseMismatchWarning([{ file: 'a.ts', line: 3, imported: './feedbackPanel', actual: 'FeedbackPanel.tsx' }]);
    expect(w).toMatch(/a\.ts:3 imports '\.\/feedbackPanel', but the file is 'FeedbackPanel\.tsx'/);
    expect(w).toMatch(/works on macOS and Windows/);
  });
});
