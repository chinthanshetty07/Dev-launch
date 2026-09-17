import { useEffect, useRef } from 'react';
import type { LogLine } from '../useSession';

/**
 * Live output.
 *
 * Sticks to the bottom only while the reader is already there — yanking the view down
 * while someone is reading earlier output is worse than a stale scroll position.
 */
export function LogTerminal({ lines, connected }: { lines: LogLine[]; connected: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    const el = box.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-edge px-4 py-2">
        <h2 className="text-[11px] uppercase tracking-[0.15em] text-muted">Live Logs</h2>
        <span className={`text-[11px] ${connected ? 'text-ok' : 'text-muted'}`}>
          {connected ? '● streaming' : '○ disconnected'}
        </span>
        <span className="ml-auto text-[11px] text-muted">{lines.length} lines</span>
      </header>

      <div
        ref={box}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-auto px-4 py-2 text-[13px] leading-6"
      >
        {lines.length === 0 && (
          <p className="text-muted">No output yet. Launch a repository to begin.</p>
        )}
        {lines.map((line, i) => (
          <div key={`${line.seq}-${i}`} className="flex gap-3 whitespace-pre-wrap break-words">
            <span className="w-12 shrink-0 select-none text-right text-edge">
              {line.seq >= 0 ? line.seq : ''}
            </span>
            <span
              className={
                line.notice === 'gap'
                  ? 'italic text-warn'
                  : line.stream === 'stderr'
                    ? 'text-bad'
                    : ''
              }
            >
              {line.text}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
