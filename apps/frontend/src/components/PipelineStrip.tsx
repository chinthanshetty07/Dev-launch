import {
  PIPELINE_STAGES,
  readyStatus,
  stageStatus,
  type ExecutionState,
  type StageStatus,
} from '@devlaunch/shared';

const STYLES: Record<StageStatus, string> = {
  pending: 'border-edge text-muted',
  active: 'border-link text-link animate-pulse',
  done: 'border-ok/60 text-ok',
  failed: 'border-bad text-bad',
  paused: 'border-warn text-warn',
};

const MARK: Record<StageStatus, string> = {
  pending: '\u00b7', active: '\u00bb', done: 'ok', failed: '\u00d7', paused: '?',
};

export function PipelineStrip({
  state,
  furthest,
  planSource,
  detected,
}: {
  state: ExecutionState | 'IDLE';
  /**
   * Furthest state the session was ever seen in. A failed session's current state says
   * nothing about where it died, so without this the strip can only grey everything out.
   */
  furthest?: ExecutionState | null;
  planSource?: string;
  detected?: string | null;
}) {
  const failedAt = state === 'FAILED' || state === 'CANCELLED';
  const ready = readyStatus(state, furthest);

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
        {/* Repair moves the session backwards to VALIDATING. Saying so is clearer than
            leaving the strip to imply the pipeline simply restarted on its own. */}
        {state === 'REPAIRING' && (
          <span className="rounded-full border border-warn px-2 py-0.5 text-[11px] text-warn">
            repairing
          </span>
        )}
        {failedAt && (
          <span className="rounded-full border border-bad px-2 py-0.5 text-[11px] text-bad">
            {state.toLowerCase()}
          </span>
        )}
      </div>

      <ol className="flex flex-wrap gap-2">
        {PIPELINE_STAGES.map((stage, i) => {
          const status = stageStatus(i, state, furthest);
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
          className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-[13px] ${STYLES[ready]}`}
        >
          <span className="w-4 text-center opacity-80">
            {ready === 'done' ? '*' : MARK[ready]}
          </span>
          Ready
        </li>
      </ol>
    </section>
  );
}
