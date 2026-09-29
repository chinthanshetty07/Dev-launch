#!/usr/bin/env node
/**
 * Real-world compatibility corpus.
 *
 * Deploys every pinned repository in corpus.json through a running DevLaunch backend —
 * the real pipeline, over its own HTTP API, with nothing stubbed — and writes a report
 * of what happened to each: detection, plan source, final state, failure code, the
 * stage it failed at, the line that decided it, and how long it took.
 *
 *   node scripts/corpus/run.mjs                      # everything
 *   node scripts/corpus/run.mjs --only mdn/todo-react,nestjs/typescript-starter
 *   node scripts/corpus/run.mjs --name baseline      # reports/baseline.{json,md}
 *   node scripts/corpus/run.mjs --report-only --name baseline   # re-render with new labels
 *
 * It refuses to run against a stale backend: a result measured against code that is not
 * the working tree is not a result. Pass --allow-stale to override, and the report says so.
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const API = option('api', 'http://localhost:3939/api');
const NAME = option('name', new Date().toISOString().replace(/[:.]/g, '-'));
const ONLY = option('only', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
/** Per repository. Generous: a cold Next.js install plus a memory retry is several minutes. */
const DEADLINE_MS = Number(option('deadline-min', '20')) * 60_000;

// PARTIALLY_READY and AWAITING_INPUT are the end of a *measurement* even though neither
// is terminal to the session: the run is over, and waiting further measures nothing.
const DONE = new Set(['READY', 'PARTIALLY_READY', 'FAILED', 'CANCELLED', 'COMPLETED', 'AWAITING_INPUT']);

/** Which part of the pipeline a failure belongs to, from the last state it was seen in. */
const STAGE_OF_STATE = {
  QUEUED: 'intake',
  CLONING: 'clone',
  ANALYZING: 'analyse',
  PLANNING: 'plan',
  VALIDATING: 'validate',
  AWAITING_INPUT: 'input',
  BUILDING: 'install',
  STARTING: 'start',
  WAITING_FOR_READY: 'readiness',
  REPAIRING: 'repair',
  READY: 'serving',
  PARTIALLY_READY: 'serving',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, init) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

/** The commit a ref currently points at, so drift from the pin is visible rather than silent. */
async function remoteTip(repo, ref) {
  try {
    const { stdout } = await run('git', ['ls-remote', `https://github.com/${repo}`, ref ?? 'HEAD'], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      timeout: 30_000,
    });
    const line = stdout.split('\n').find((l) => l.endsWith(ref ? `refs/heads/${ref}` : 'HEAD'));
    return line?.split('\t')[0] ?? null;
  } catch {
    return null;
  }
}

/** Whether the URL a session handed out actually answers. READY is a claim; this checks it. */
async function probe(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    return res.status;
  } catch (err) {
    return `error: ${err.cause?.code ?? err.message}`;
  }
}

async function waitForFreeSlot() {
  for (let i = 0; i < 60; i++) {
    const { body } = await api('/sessions');
    if (!Array.isArray(body) || !body.some((s) => s.active)) return;
    await sleep(1000);
  }
  throw new Error('A session is still active after 60s; refusing to measure alongside it.');
}

/** The first thing that went wrong, whether the session failed or one of its services did. */
function firstFailure(s) {
  if (s.failure) return { ...s.failure, service: undefined };
  const sv = (s.services ?? []).find((x) => x.failure);
  return sv ? { ...sv.failure, service: sv.name } : null;
}

async function deploy(entry) {
  const t0 = Date.now();
  const record = {
    repo: entry.repo,
    category: entry.category,
    exercises: entry.exercises,
    pinnedSha: entry.sha,
    ref: entry.ref ?? null,
  };

  // Recorded, not enforced. A backend without ref selection clones the default branch
  // tip, and the report must say when that is not the commit the result claims to be for.
  record.remoteTip = await remoteTip(entry.repo, entry.ref);

  await waitForFreeSlot();
  const created = await api('/sessions', {
    method: 'POST',
    body: JSON.stringify({ repoUrl: `https://github.com/${entry.repo}`, ref: entry.sha }),
  });
  if (created.status >= 300 || !created.body.id) {
    return {
      ...record,
      outcome: 'REFUSED',
      finalState: 'REFUSED',
      failureCode: created.body.code ?? `HTTP_${created.status}`,
      stage: 'intake',
      evidence: String(created.body.error ?? created.body.raw ?? '').slice(0, 300),
      durationS: Math.round((Date.now() - t0) / 1000),
    };
  }

  const id = created.body.id;
  const transitions = [];
  let s;
  let last;
  let gateSkipped = null;
  while (Date.now() - t0 < DEADLINE_MS) {
    await sleep(1000);
    s = (await api(`/sessions/${id}`)).body;
    if (s.state !== last) {
      transitions.push({ state: s.state, atS: Math.round((Date.now() - t0) / 1000) });
      last = s.state;
    }
    // The configuration gate is skippable by design, and skipping it is the only way to
    // learn whether the application runs at all without the values it asked for. Once:
    // a second gate is a different question, and a package choice is never guessed.
    if (s.state === 'AWAITING_INPUT' && !gateSkipped && !flag('keep-gate') && s.pending?.requiredEnv?.length && !s.pending?.choices?.length) {
      gateSkipped = s.pending.requiredEnv.map((v) => v.key);
      await api(`/sessions/${id}/resolve`, { method: 'POST', body: JSON.stringify({ env: {} }) });
      continue;
    }
    if (DONE.has(s.state)) break;
  }
  const timedOut = !DONE.has(s?.state);
  const durationS = Math.round((Date.now() - t0) / 1000);

  // The last state before the ending is where it stopped making progress.
  const before = transitions.filter((t) => !['FAILED', 'CANCELLED', 'CLEANING_UP', 'COMPLETED'].includes(t.state)).at(-1);
  const failure = firstFailure(s);

  const checks = [];
  for (const sv of s.services ?? []) {
    if (sv.url) checks.push({ service: sv.name, url: sv.url, status: await probe(sv.url) });
  }
  if (!s.services?.length && s.url) checks.push({ service: null, url: s.url, status: await probe(s.url) });

  let outcome;
  if (timedOut) outcome = 'HARNESS_TIMEOUT';
  else if (s.state === 'READY') outcome = 'PASS';
  else if (s.state === 'PARTIALLY_READY') outcome = 'PARTIAL';
  else if (s.state === 'AWAITING_INPUT') outcome = 'NEEDS_INPUT';
  else outcome = 'FAIL';

  // READY whose URL does not answer is the one result that must never be counted as a
  // pass: a false READY is worse than a failure, because it stops somebody looking.
  if (outcome === 'PASS' && checks.some((c) => typeof c.status !== 'number')) outcome = 'FALSE_READY';

  const result = {
    ...record,
    sessionId: id,
    outcome,
    finalState: s.state,
    detected: s.detected ?? null,
    planSource: s.plan?.planSource ?? (s.services?.length ? 'rule-based' : null),
    plan: s.plan
      ? {
          runtime: `${s.plan.runtime.language} ${s.plan.runtime.version}`,
          install: s.plan.installCommand,
          start: s.plan.startCommand,
          port: s.plan.expectedPort,
          dir: s.plan.workingDirectory,
        }
      : null,
    services: (s.services ?? []).map((sv) => ({
      name: sv.name,
      role: sv.role,
      state: sv.state,
      url: sv.url ?? null,
      runtime: sv.plan?.runtime,
      start: sv.plan?.startCommand,
      failureCode: sv.failure?.code ?? null,
    })),
    // Not failure codes — the two endings that carry none — named so they group.
    failureCode:
      failure?.code ??
      (outcome === 'NEEDS_INPUT' ? '(AWAITING_INPUT)' : s.state === 'COMPLETED' ? '(COMPLETED, no port)' : null),
    failureService: failure?.service ?? null,
    stage: failure?.phase ?? (outcome === 'PASS' ? null : STAGE_OF_STATE[before?.state] ?? before?.state ?? null),
    message: failure?.message?.slice(0, 400) ?? null,
    evidence: failure?.evidence?.slice(0, 300) ?? null,
    confidence: failure?.confidence ?? null,
    repairs: (s.repairs ?? []).map((r) => `${r.source}:${r.type}`),
    pending: s.pending ?? null,
    gateSkipped,
    warnings: (s.planWarnings ?? []).map((w) => w.slice(0, 240)),
    browserProblems: s.browserProblems ?? [],
    checks,
    transitions,
    durationS,
  };

  await api(`/sessions/${id}/cancel`, { method: 'POST' }).catch(() => undefined);
  return result;
}

function bucket(results, key) {
  const m = new Map();
  for (const r of results) {
    const k = key(r) ?? '—';
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function render(report, labels) {
  const rs = report.results;
  const pass = rs.filter((r) => r.outcome === 'PASS').length;
  const partial = rs.filter((r) => r.outcome === 'PARTIAL').length;
  const label = (r) => (r.outcome === 'PASS' ? 'PASS' : labels[r.repo]?.label ?? 'UNLABELLED');

  const lines = [];
  lines.push(`# Corpus report — ${report.name}`, '');
  lines.push(`Backend \`${report.backend.running?.slice(0, 7)}\` (stale: ${report.backend.stale}), egress ${report.backend.egress}, ${report.startedAt}.`);
  lines.push('');
  lines.push(`**${pass} / ${rs.length} READY** (${Math.round((100 * pass) / rs.length)}%)` +
    (partial ? `, ${partial} partially ready` : '') +
    `, ${rs.filter((r) => r.detected === 'ai-fallback').length} planned by the model, ` +
    `${rs.filter((r) => (r.repairs ?? []).some((x) => x.startsWith('ai:'))).length} with a model repair, ` +
    `${Math.round(rs.reduce((a, r) => a + r.durationS, 0) / 60)} min total.`);
  lines.push('');
  lines.push('| Outcome | Count |', '|---|---|');
  for (const [k, n] of bucket(rs, (r) => r.outcome)) lines.push(`| ${k} | ${n} |`);
  lines.push('', '### Failures by code', '', '| Failure code | Count |', '|---|---|');
  for (const [k, n] of bucket(rs.filter((r) => r.outcome !== 'PASS'), (r) => r.failureCode)) lines.push(`| ${k} | ${n} |`);
  lines.push('', '### Failures by label', '', '| Label | Count |', '|---|---|');
  for (const [k, n] of bucket(rs.filter((r) => r.outcome !== 'PASS'), label)) lines.push(`| ${k} | ${n} |`);
  lines.push('', '## Results', '');
  lines.push('| Repository | Category | Detected | Plan | State | Code | Stage | Label | s |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const r of rs) {
    const pinned = r.remoteTip && r.remoteTip !== r.pinnedSha ? ' ⚠ tip≠pin' : '';
    lines.push(
      `| ${r.repo}${pinned} | ${r.category} | ${r.detected ?? '—'} | ${r.planSource ?? '—'} | ${r.finalState} | ` +
        `${r.failureCode ?? ''} | ${r.stage ?? ''} | ${label(r)} | ${r.durationS} |`,
    );
  }
  lines.push('', '## Evidence', '');
  for (const r of rs.filter((x) => x.outcome !== 'PASS')) {
    lines.push(`### ${r.repo} — ${r.failureCode ?? r.outcome}`);
    if (labels[r.repo]) lines.push(`**${labels[r.repo].label}** — ${labels[r.repo].reason}`, '');
    if (r.plan) lines.push(`- plan: \`${r.plan.install ?? '(no install)'}\` → \`${r.plan.start}\` (${r.plan.runtime}, port ${r.plan.port}, dir ${r.plan.dir})`);
    for (const sv of r.services) lines.push(`- service ${sv.name} [${sv.role}] ${sv.state} ${sv.failureCode ?? ''} \`${sv.start ?? ''}\``);
    if (r.message) lines.push(`- message: ${r.message.replace(/\n/g, ' ')}`);
    if (r.evidence) lines.push(`- evidence: \`${r.evidence.replace(/`/g, "'").replace(/\n/g, ' ')}\``);
    if (r.repairs.length) lines.push(`- repairs: ${r.repairs.join(', ')}`);
    if (r.pending) lines.push(`- pending: ${JSON.stringify(r.pending).slice(0, 300)}`);
    if (r.gateSkipped) lines.push(`- configuration gate skipped, unset: ${r.gateSkipped.join(', ')}`);
    for (const c of r.checks) lines.push(`- probe ${c.service ?? ''} ${c.url} → ${c.status}`);
    lines.push('');
  }
  return lines.join('\n');
}

async function main() {
  const corpus = JSON.parse(await readFile(join(HERE, 'corpus.json'), 'utf8'));
  const labels = JSON.parse(await readFile(join(HERE, 'labels.json'), 'utf8').catch(() => '{}'));
  const outDir = join(HERE, 'reports');
  await mkdir(outDir, { recursive: true });
  const jsonPath = join(outDir, `${NAME}.json`);

  if (flag('report-only')) {
    const report = JSON.parse(await readFile(jsonPath, 'utf8'));
    await writeFile(join(outDir, `${NAME}.md`), render(report, labels));
    console.log(`rendered ${join(outDir, `${NAME}.md`)}`);
    return;
  }

  const health = (await api('/health')).body;
  if (!health.ok) throw new Error(`Backend at ${API} is not healthy: ${JSON.stringify(health)}`);
  if (health.build?.stale && !flag('allow-stale')) {
    throw new Error('The backend is running code older than the working tree. Restart it, or pass --allow-stale.');
  }

  const entries = corpus.repos.filter((e) => ONLY.length === 0 || ONLY.includes(e.repo));
  // Merged into an existing report of the same name, so a subset can be re-run in place.
  const previous = JSON.parse(await readFile(jsonPath, 'utf8').catch(() => 'null'));
  const report = {
    name: NAME,
    startedAt: previous?.startedAt ?? new Date().toISOString(),
    // A subset re-run keeps the original header when the same process measured it: the
    // working tree may have moved on, and `stale` then describes the tree, not the run.
    backend:
      previous?.backend?.running === health.build?.running
        ? previous.backend
        : { running: health.build?.running, stale: health.build?.stale ?? null, egress: health.egress ?? null },
    results: previous?.results ?? [],
  };

  for (const [i, entry] of entries.entries()) {
    process.stdout.write(`[${i + 1}/${entries.length}] ${entry.repo} … `);
    let result;
    try {
      result = await deploy(entry);
    } catch (err) {
      result = { repo: entry.repo, category: entry.category, outcome: 'HARNESS_ERROR', finalState: 'HARNESS_ERROR', failureCode: null, stage: null, evidence: String(err).slice(0, 300), durationS: 0, services: [], repairs: [], checks: [], warnings: [] };
    }
    console.log(`${result.outcome} ${result.failureCode ?? ''} ${result.durationS}s`);
    report.results = report.results.filter((r) => r.repo !== entry.repo);
    report.results.push(result);
    // Written after every repository, so an interrupted run keeps what it measured.
    report.results.sort((a, b) =>
      corpus.repos.findIndex((e) => e.repo === a.repo) - corpus.repos.findIndex((e) => e.repo === b.repo),
    );
    await writeFile(jsonPath, JSON.stringify(report, null, 2));
    await writeFile(join(outDir, `${NAME}.md`), render(report, labels));
  }
  console.log(`\n${join(outDir, `${NAME}.md`)}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
