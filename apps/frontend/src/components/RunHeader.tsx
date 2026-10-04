import { useEffect, useState } from 'react';
import { describeState, type ExecutionState } from '@devlaunch/shared';
import { shortRepo } from './LaunchView';

/**
 * What is happening, to what, and for how long.
 *
 * The old header showed a lowercase state name — `waiting_for_ready` — in 11px grey in
 * a corner. That is internal vocabulary, and on a slow install it is the only thing
 * moving for four minutes, which reads as a hang. A sentence and a running clock are
 * the difference between "it is stuck" and "it is installing, as expected".
 */
export function RunHeader({
  state,
  repoUrl,
  refName,
  commit,
  deploymentId,
  startedAt,
  readyAt,
  busy,
  onStop,
  onNew,
}: {
  state: ExecutionState | 'IDLE';
  repoUrl?: string;
  /** Which branch or tag, and which commit, this is — so nobody tests yesterday's code. */
  refName?: string;
  commit?: string | null;
  deploymentId?: string;
  startedAt?: number;
  /** Frozen point for a session that reached READY, so the clock stops meaning something else. */
  readyAt?: number;
  busy: boolean;
  onStop: () => void;
  onNew: () => void;
}) {
  // Two different questions, which were one flag and one answer.
  //
  // The clock stops when the run stops. The Stop button goes away only when there is
  // nothing left to stop — and a READY session is the case where those differ: its
  // containers are up, it holds the only slot, and it was the one state offering no way
  // to end it. "Run another" simply cleared the view, leaving the session running and
  // the next launch refused with "a session is already running", which had to be
  // resolved through an error banner two screens later.
  const finished = TERMINAL.includes(state);
  const running = RUNNING.includes(state);
  // The clock stops at READY as well: the run took what it took, and a duration that
  // keeps climbing while the application serves traffic is measuring something else.
  const settled = finished || SERVING.includes(state);
  const elapsed = useElapsed(startedAt, settled ? (readyAt ?? null) : undefined);

  return (
    <header className="sticky top-0 z-10 border-b border-edge bg-panel">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <button
          type="button"
          onClick={onNew}
          className="text-[13px] font-semibold uppercase tracking-[0.2em] hover:text-link"
          title="Start something else"
        >
          DevLaunch
        </button>

        {repoUrl && (
          <a
            href={repoUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="max-w-[28ch] truncate text-[13px] text-link hover:underline"
          >
            {shortRepo(repoUrl)}
          </a>
        )}
        {(commit || deploymentId) && (
          <span className="text-[12px] text-muted" data-testid="deployment-identity">
            {refName ?? 'default branch'}
            {commit && <> @ <span className="font-mono">{commit.slice(0, 7)}</span></>}
            {deploymentId && <> · deploy <span className="font-mono">{deploymentId.slice(0, 8)}</span></>}
          </span>
        )}

        <span className={`flex items-center gap-2 text-[13px] ${TONE[toneOf(state)]}`}>
          <Spinner active={!settled && state !== 'AWAITING_INPUT' && state !== 'IDLE'} />
          {describeState(state)}
        </span>

        <div className="ml-auto flex items-center gap-3">
          {startedAt && (
            <span className="tabular-nums text-[12px] text-muted" title="elapsed">
              {elapsed}
            </span>
          )}
          {running && (
            <button
              type="button"
              onClick={onStop}
              disabled={busy}
              className="rounded-md border border-edge px-3 py-1.5 text-[12px] hover:border-bad hover:text-bad disabled:opacity-40"
              title={
                SERVING.includes(state)
                  ? 'Shut the application down and release the slot'
                  : 'Stop this run'
              }
            >
              {SERVING.includes(state) ? 'Shut down' : 'Stop'}
            </button>
          )}
          {finished && (
            <button
              type="button"
              onClick={onNew}
              className="rounded-md border border-link px-3 py-1.5 text-[12px] text-link hover:bg-link/10"
            >
              Run another
            </button>
          )}
        </div>
      </div>
    </header>
  );
}

/** Nothing left to stop: the clock is frozen and the slot is already free. */
const TERMINAL: string[] = ['FAILED', 'CANCELLED', 'COMPLETED'];

/**
 * Something is running that stopping would end.
 *
 * READY is in both lists' spirit and neither's letter: the run is over, and the
 * application it produced is still up. The clock treats it as finished; the button
 * treats it as running, because it is the state with the most to stop.
 */
const RUNNING: string[] = [
  'QUEUED', 'CLONING', 'ANALYZING', 'PLANNING', 'VALIDATING', 'AWAITING_INPUT',
  'BUILDING', 'STARTING', 'WAITING_FOR_READY', 'REPAIRING', 'CLEANING_UP', 'READY',
  'PARTIALLY_READY',
];

/**
 * States where the run is over and containers are still up.
 *
 * Both of them: what the button offers is the same either way, because what there is to
 * stop is the same either way.
 */
const SERVING: string[] = ['READY', 'PARTIALLY_READY'];

const TONE = {
  ok: 'text-ok',
  bad: 'text-bad',
  warn: 'text-warn',
  busy: 'text-fg',
  idle: 'text-muted',
} as const;

function toneOf(state: ExecutionState | 'IDLE'): keyof typeof TONE {
  if (state === 'READY' || state === 'COMPLETED') return 'ok';
  if (state === 'PARTIALLY_READY') return 'warn';
  if (state === 'FAILED') return 'bad';
  if (state === 'AWAITING_INPUT' || state === 'REPAIRING' || state === 'CANCELLED') return 'warn';
  if (state === 'IDLE') return 'idle';
  return 'busy';
}

function Spinner({ active }: { active: boolean }): React.ReactElement | null {
  if (!active) return null;
  return (
    <span
      aria-hidden
      className="h-2.5 w-2.5 animate-spin rounded-full border border-current border-t-transparent"
    />
  );
}

/**
 * mm:ss the run has been going, or took.
 *
 * `endedAt` distinguishes three cases that a single "frozen" flag conflated. While the
 * session runs it ticks. When it finished and we know when — a session that reached
 * READY records it — that duration is the answer for good. When it finished and we do
 * not, this says nothing at all: a page opened an hour after a failure would otherwise
 * report the run took an hour, which is not a measurement of anything.
 */
function useElapsed(startedAt: number | undefined, endedAt: number | null | undefined): string {
  const live = endedAt === undefined;
  const [, tick] = useState(0);

  useEffect(() => {
    if (!startedAt || !live) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [startedAt, live]);

  if (!startedAt) return '';
  if (endedAt === null) return '';
  const total = Math.max(0, Math.round(((endedAt ?? Date.now()) - startedAt) / 1000));
  const mins = Math.floor(total / 60);
  return `${mins}:${String(total % 60).padStart(2, '0')}`;
}
