import { useEffect, useMemo, useRef, useState } from 'react';
import type { LogLine } from '../useSession';

/**
 * Live output.
 *
 * Sticks to the bottom only while the reader is already there — yanking the view down
 * while someone is reading earlier output is worse than a stale scroll position.
 *
 * The filter exists because an install writes several hundred lines and the one that
 * matters is usually red. Scrolling back through npm's output to find it, on a log that
 * is still growing underneath you, is the single most tedious thing about reading a
 * failed run.
 */
export function LogTerminal({
  lines,
  connected,
  grow = true,
}: {
  lines: LogLine[];
  connected: boolean;
  /**
   * Whether the log claims the remaining height. False once there is a result above it
   * worth more of the screen than the output that produced it.
   */
  grow?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [query, setQuery] = useState('');
  const [errorsOnly, setErrorsOnly] = useState(false);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return lines.filter(
      (l) =>
        (!errorsOnly || l.stream === 'stderr') && (q === '' || l.text.toLowerCase().includes(q)),
    );
  }, [lines, query, errorsOnly]);

  const errorCount = useMemo(() => lines.filter((l) => l.stream === 'stderr').length, [lines]);

  useEffect(() => {
    const el = box.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [shown]);

  const onScroll = (): void => {
    const el = box.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const filtering = errorsOnly || query.trim() !== '';

  return (
    <section className={`flex min-h-0 flex-col ${grow ? 'flex-1' : 'h-80 shrink-0'}`}>
      <header className="flex flex-wrap items-center gap-3 border-y border-edge bg-panel px-4 py-2">
        <h2 className="text-[11px] uppercase tracking-[0.15em] text-muted">Live logs</h2>
        <span className={`text-[11px] ${connected ? 'text-ok' : 'text-muted'}`}>
          {connected ? '● streaming' : '○ disconnected'}
        </span>

        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter…"
          aria-label="Filter log lines"
          spellCheck={false}
          className="ml-auto w-40 rounded-md border border-edge bg-ink px-2 py-1 text-[12px] outline-none focus:border-link"
        />
        <button
          type="button"
          onClick={() => setErrorsOnly((v) => !v)}
          aria-pressed={errorsOnly}
          className={`rounded-md border px-2 py-1 text-[11px] ${
            errorsOnly ? 'border-bad text-bad' : 'border-edge text-muted hover:border-bad hover:text-bad'
          }`}
        >
          Errors only{errorCount > 0 ? ` (${errorCount})` : ''}
        </button>
        <span className="text-[11px] tabular-nums text-muted">
          {filtering ? `${shown.length} of ${lines.length}` : `${lines.length} lines`}
        </span>
      </header>

      <div
        ref={box}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-auto px-4 py-2 text-[13px] leading-6"
      >
        {lines.length === 0 && <p className="text-muted">No output yet.</p>}
        {lines.length > 0 && shown.length === 0 && (
          <p className="text-muted">
            Nothing matches that filter. {lines.length} line{lines.length === 1 ? '' : 's'} hidden.
          </p>
        )}
        {shown.map((line, i) => (
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
