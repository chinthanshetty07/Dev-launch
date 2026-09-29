import type { FailureDetail, RepairRecord } from '@devlaunch/shared';

/**
 * A failure, shown with the evidence behind it.
 *
 * The evidence line is what makes a verdict checkable rather than merely confident, and
 * an uncertain classification says so instead of implying a diagnosis it does not have.
 */
export function FailurePanel({ failure, repairs }: { failure?: FailureDetail; repairs?: RepairRecord[] }) {
  if (!failure) return null;
  const uncertain = failure.confidence === 'low';

  return (
    <section className="m-4 rounded-lg border border-bad/60 bg-panel p-4 text-[13px]">
      <div className="mb-2 flex items-center gap-2">
        <span className="rounded-full border border-bad px-2 py-0.5 text-[11px] text-bad">
          {failure.code}
        </span>
        {uncertain && (
          <span className="rounded-full border border-warn px-2 py-0.5 text-[11px] text-warn">
            uncertain
          </span>
        )}
        {failure.phase && <span className="text-muted">during {failure.phase}</span>}
      </div>

      <p className="mb-2">{failure.message}</p>

      {/* Which memory ran out, under what limit, and how it was known — the difference
          between "give it more" and "the machine is the limit" is in these numbers. */}
      {failure.memory && (
        <p className="mb-2 text-muted" data-testid="failure-memory">
          {failure.memory.kind === 'node-heap' ? 'Node heap' : 'container memory'} · limit{' '}
          {failure.memory.limitMb} MB
          {failure.memory.maximumMb !== undefined && ` of ${failure.memory.maximumMb} MB available`}
          {failure.memory.attempts !== undefined &&
            ` · ${failure.memory.attempts} attempt${failure.memory.attempts === 1 ? '' : 's'}`}
          {failure.memory.retryable === false && ' · not retried further'}
          {failure.memory.detectedBy.length > 0 && ` · detected by ${failure.memory.detectedBy.join(', ')}`}
        </p>
      )}

      {failure.evidence && (
        <pre className="mb-2 overflow-x-auto rounded border border-edge bg-ink p-2 text-muted">
          {failure.evidence}
        </pre>
      )}

      {failure.remedy && (
        <p className="text-link">
          <span className="text-muted">remedy: </span>
          {failure.remedy}
        </p>
      )}

      {/* Without this the plan on screen and the failure disagree on their face — a
          start command reading `--port 8080` beside "Nothing is listening on port 8000"
          — because the plan is the last one repair produced and the diagnosis is the
          first one taken. Both are deliberate; the pairing is what needs explaining. */}
      {/* Each repair, typed: a rule quoting the manifest or log line that justified it,
          or a model rewriting the plan. Reading these is how a person tells "it tried the
          obvious thing and the obvious thing was wrong" from "it guessed twice". */}
      {repairs && repairs.length > 0 && (
        <ul className="mt-2 border-t border-edge pt-2 text-[12px]">
          {repairs.map((r, i) => (
            <li key={i} className="mb-1">
              <span
                className={`mr-2 rounded-full border px-2 py-0.5 text-[11px] ${
                  r.source === 'deterministic' ? 'border-link text-link' : 'border-warn text-warn'
                }`}
              >
                {r.source === 'deterministic' ? 'rule' : 'model'}
              </span>
              {/* Which service. "The start command was corrected" says nothing useful
                  when four applications are running and three were already working. */}
              {r.service && <span className="mr-2 font-medium">{r.service}</span>}
              <span className="text-muted">{r.type.toLowerCase().replace(/_/g, ' ')}: </span>
              {Object.entries(r.after)
                .map(([k, v]) => `${k} → ${String(v)}`)
                .join(', ')}
              {r.evidence.length > 0 && (
                <span className="block pl-2 text-muted">because {r.evidence.join('; ')}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {(failure.repairAttemptsAfter ?? 0) > 0 && (
        <p className="mt-2 border-t border-edge pt-2 text-[12px] text-muted">
          This describes the first attempt. The plan shown above was rewritten{' '}
          {failure.repairAttemptsAfter} time{failure.repairAttemptsAfter === 1 ? '' : 's'} by
          automated repair, and none of those worked either. The first diagnosis is kept
          because it describes your repository; the later ones describe plans the model
          invented.
        </p>
      )}
    </section>
  );
}
