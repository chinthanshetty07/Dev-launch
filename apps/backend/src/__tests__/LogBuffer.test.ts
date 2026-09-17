import { describe, it, expect } from 'vitest';
import { LogBuffer } from '../services/logs/LogBuffer.js';

describe('LogBuffer', () => {
  it('assigns monotonic sequence numbers', () => {
    const b = new LogBuffer();
    expect(b.push('stdout', 'a').seq).toBe(0);
    expect(b.push('stdout', 'b').seq).toBe(1);
    expect(b.push('stderr', 'c').seq).toBe(2);
  });

  it('evicts by line count', () => {
    const b = new LogBuffer(1024 * 1024, 3);
    for (const t of ['a', 'b', 'c', 'd', 'e']) b.push('stdout', t);
    expect(b.all().map((e) => e.text)).toEqual(['c', 'd', 'e']);
    expect(b.stats.droppedTotal).toBe(2);
  });

  it('evicts by bytes before the line cap is reached', () => {
    // The whole reason the cap is bytes-first: 10k lines of build output can be 50 MB.
    const b = new LogBuffer(100, 10_000);
    for (let i = 0; i < 10; i++) b.push('stdout', 'x'.repeat(30));
    expect(b.stats.bytes).toBeLessThanOrEqual(100);
    expect(b.all().length).toBeLessThan(10);
    expect(b.stats.droppedTotal).toBeGreaterThan(0);
  });

  it('counts multi-byte characters by byte length, not character length', () => {
    const b = new LogBuffer(1024 * 1024, 10_000);
    b.push('stdout', '✓'); // 3 bytes in UTF-8
    expect(b.stats.bytes).toBe(3);
  });

  it('returns only entries after the requested sequence', () => {
    const b = new LogBuffer();
    for (const t of ['a', 'b', 'c']) b.push('stdout', t);
    const slice = b.since(0);
    expect(slice.entries.map((e) => e.text)).toEqual(['b', 'c']);
    expect(slice.gap).toBe(false);
  });

  it('reports a gap when a reconnecting client asks for evicted entries', () => {
    const b = new LogBuffer(1024 * 1024, 2);
    for (const t of ['a', 'b', 'c', 'd']) b.push('stdout', t);
    // Entries 0 and 1 are gone; a client resuming from seq 0 wants seq 1, which is lost.
    const slice = b.since(0);
    expect(slice.gap).toBe(true);
    expect(slice.droppedTotal).toBe(2);
  });

  it('reports no gap when the client is fully caught up', () => {
    const b = new LogBuffer();
    b.push('stdout', 'a');
    expect(b.since(0).gap).toBe(false);
    expect(b.since(0).entries).toEqual([]);
  });
});

describe('stripAnsi', () => {
  const ESC = '\u001b';
  const BEL = '\u0007';

  it('removes colour codes so classifier signatures still match', async () => {
    // Flask and pip both emit coloured output. A signature anchored on "WARNING"
    // would silently miss it if the escape prefix survived.
    const { stripAnsi } = await import('../services/logs/LogManager.js');
    expect(stripAnsi(`${ESC}[31m${ESC}[1mWARNING: dev server${ESC}[0m`)).toBe(
      'WARNING: dev server',
    );
    expect(stripAnsi(`${ESC}[32mok${ESC}[39m`)).toBe('ok');
  });

  it('leaves ordinary text untouched', async () => {
    const { stripAnsi } = await import('../services/logs/LogManager.js');
    expect(stripAnsi('plain output [not ansi] 100%')).toBe('plain output [not ansi] 100%');
  });

  it('removes cursor movement and terminal title sequences', async () => {
    const { stripAnsi } = await import('../services/logs/LogManager.js');
    expect(stripAnsi(`${ESC}[2K${ESC}[1Gprogress`)).toBe('progress');
    expect(stripAnsi(`${ESC}]0;title${BEL}done`)).toBe('done');
  });
});
