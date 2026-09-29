#!/usr/bin/env node
/**
 * Print a corpus session's log, from the backend's in-memory buffer.
 *
 *   node scripts/corpus/logs.mjs <repo|sessionId> [--report baseline] [--grep pattern] [--tail 80]
 *
 * Sessions live in memory, so this works only against the backend that ran them.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const target = args[0];
const report = JSON.parse(
  await readFile(join(dirname(fileURLToPath(import.meta.url)), 'reports', `${opt('report', 'baseline')}.json`), 'utf8'),
);
const id = report.results.find((r) => r.repo === target)?.sessionId ?? target;
const grep = opt('grep') ? new RegExp(opt('grep'), 'i') : null;
const tail = Number(opt('tail', '80'));

const lines = [];
const ws = new WebSocket(`ws://localhost:3939/ws/sessions/${id}/logs`);
const done = () => {
  const out = grep ? lines.filter((l) => grep.test(l)) : lines;
  console.log(out.slice(-tail).join('\n'));
  process.exit(0);
};
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.type === 'logs') for (const x of m.entries) lines.push(x.text);
  if (m.type === 'end') done();
};
ws.onerror = () => done();
setTimeout(done, 5000);
