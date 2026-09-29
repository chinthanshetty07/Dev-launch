import { describe, it, expect } from 'vitest';
import { Sentinel } from '@devlaunch/shared';
import { LogManager } from '../services/logs/LogManager.js';
import { phaseLog } from '../services/execution/ExecutionManager.js';
import { dockerFramedInto } from './helpers/dockerFramed.js';

/** Feed lines through the real framed-ingestion path and wait until they have all landed. */
async function ingested(lines: string[]): Promise<LogManager> {
  const logs = new LogManager();
  let sentinels = 0;
  logs.on('sentinel', () => sentinels++);
  dockerFramedInto(logs, lines);
  const expected = lines.length;
  for (let i = 0; i < 100 && logs.buffer.all().length + sentinels < expected; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  return logs;
}

describe('the part of a log that can explain a phase', () => {
  const run = [
    Sentinel.INSTALL_BEGIN,
    'npm warn EBADENGINE Unsupported engine {',
    'git command not found',
    Sentinel.INSTALL_OK,
    Sentinel.START_BEGIN,
    '> node --env-file=.env server.js',
    'node: .env: not found',
  ];

  it('gives a failed start only what the start printed', async () => {
    // Sentinels never enter the buffer, so the boundary has to be remembered where it
    // fell; without it, husky's install-time `git command not found` explained a start
    // that failed for another reason.
    const logs = await ingested(run);
    expect(phaseLog(logs, 'start').map((e) => e.text)).toEqual([
      '> node --env-file=.env server.js',
      'node: .env: not found',
    ]);
  });

  it('gives a failed install everything from its own beginning', async () => {
    const logs = await ingested(run);
    expect(phaseLog(logs, 'install').map((e) => e.text)[0]).toBe('npm warn EBADENGINE Unsupported engine {');
  });

  it('falls back to the whole log for a phase that never began', async () => {
    const logs = await ingested(['something before any marker', Sentinel.INSTALL_BEGIN, 'installing']);
    expect(phaseLog(logs, 'start').map((e) => e.text)).toEqual(['something before any marker', 'installing']);
    expect(phaseLog(logs, 'none')).toHaveLength(2);
  });

  it('divides a reused log by the latest attempt', async () => {
    // A repair reruns in a fresh container that writes into the same session log.
    const logs = await ingested([Sentinel.START_BEGIN, 'first attempt', Sentinel.START_BEGIN, 'second attempt']);
    expect(phaseLog(logs, 'start').map((e) => e.text)).toEqual(['second attempt']);
  });
});
