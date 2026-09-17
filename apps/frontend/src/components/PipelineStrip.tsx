import type { ExecutionState } from '@devlaunch/shared';

export type StageStatus = 'pending' | 'active' | 'done' | 'failed' | 'paused';

/** The pipeline as a user experiences it, which is coarser than the state machine. */
const STAGES = [
  { key: 'clone', label: 'Clone', states: ['CLONING'] },
  { key: 'analyze', label: 'Analyze', states: ['ANALYZING'] },
  { key: 'plan', label: 'Plan', states: ['PLANNING'] },
  { key: 'validate', label: 'Validate', states: ['VALIDATING', 'AWAITING_INPUT'] },
  { key: 'start', label: 'Start', states: ['BUILDING', 'STARTING'] },
  { key: 'ready', label: 'Readiness', states: ['WAITING_FOR_READY'] },
] as const;

const ORDER: string[] = [
  'QUEUED', 'CLONING', 'ANALYZING', 'PLANNING', 'VALIDATING', 'AWAITING_INPUT',
  'BUILDING', 'STARTING', 'WAITING_FOR_READY', 'READY',
];

function statusFor(stageIndex: number, state: ExecutionState | 'IDLE'): StageStatus {
  if (state === 'IDLE') return 'pending';
  if (state === 'READY' || state === 'COMPLETED') return 'done';

  const stage = STAGES[stageIndex]!;
  const terminalFailure = state === 'FAILED' || state === 'CANCELLED';
  const position = ORDER.indexOf(state);
  // A failed or cancelled session stops advancing, so the furthest stage it reached is
  // inferred from the states already passed rather than from the terminal state itself.
  const effective = terminalFailure ? ORDER.length : position;

  if ((stage.states as readonly string[]).includes(state)) {
    if (state === 'AWAITING_INPUT') return 'paused';
    return 'active';
  }

  const stageStart = ORDER.indexOf(stage.states[0]);
  if (terminalFailure) return 'pending';
  return effective > stageStart ? 'done' : 'pending';
}

const STYLES: Record<StageStatus, string> = {
  pending: 'border-edge text-muted',
  active: 'border-link text-link animate-pulse',
  done: 'border-ok/60 text-ok',
  failed: 'border-bad text-bad',
  paused: 'border-warn text-warn',
};

const MARK: Record<StageStatus, string> = {
  pending: '·', active: '»', done: 'ok', failed: '×', paused: '?',
};

export function PipelineStrip({
  state,
  planSource,
  detected,
}: {
  state: ExecutionState | 'IDLE';
  planSource?: string;
  detected?: string | null;
}) {
  const failedAt = state === 'FAILED' || state === 'CANCELLED';

  return (
    <section className="border-b border-edge bg-panel px-4 py-3">
      <div className="mb-2 flex items-center gap-3">
        <h2 className="text-[11px] uppercase tracking-[0.15em] text-muted">Execution Pipeline</h2>
        {/* Showing how the plan was produced is the cheapest way to make the hybrid
            architecture legible at a glance. */}
        {planSource && (
          <span className="rounded-full border border-ok/50 px-2 py-0.5 text-[11px] text-ok">
            plan: {planSource}
          </span>
        )}
        {detected && (
          <span className="rounded-full border border-edge px-2 py-0.5 text-[11px] text-muted">
            detected: {detected}
          </span>
        )}
        {failedAt && (
          <span className="rounded-full border border-bad px-2 py-0.5 text-[11px] text-bad">
            {state.toLowerCase()}
          </span>
        )}
      </div>

      <ol className="flex flex-wrap gap-2">
        {STAGES.map((stage, i) => {
          const status = statusFor(i, state);
          return (
            <li
              key={stage.key}
              className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-[13px] ${STYLES[status]}`}
            >
              <span className="w-4 text-center opacity-80">{MARK[status]}</span>
              {stage.label}
            </li>
          );
        })}
        <li
          className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-[13px] ${
            state === 'READY' ? STYLES.done : STYLES.pending
          }`}
        >
          <span className="w-4 text-center opacity-80">{state === 'READY' ? '*' : '·'}</span>
          Ready
        </li>
      </ol>
    </section>
  );
}
