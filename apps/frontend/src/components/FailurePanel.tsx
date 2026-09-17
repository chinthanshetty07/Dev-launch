import type { FailureDetail } from '@devlaunch/shared';

/**
 * A failure, shown with the evidence behind it.
 *
 * The evidence line is what makes a verdict checkable rather than merely confident, and
 * an uncertain classification says so instead of implying a diagnosis it does not have.
 */
export function FailurePanel({ failure }: { failure?: FailureDetail }) {
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
    </section>
  );
}
