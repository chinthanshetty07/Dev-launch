import type { FailureDetail, RepairRecord } from '@devlaunch/shared';

/**
 * A run that failed a try and is trying again, said as that.
 *
 * The red failure panel used to appear the moment the first try failed and stay there while
 * DevLaunch retried — so a run that was about to succeed at 2048 MB looked finished and
 * broken, and was stopped from the dashboard mid-retry (`wrrnlim/nextjs-docker-postgres-
 * template`). While a session is still running, the first failure is the reason for a
 * retry, not the result, and is shown in the warning colour with what happens next. The red
 * panel is for when every try is spent.
 */
export function RetryPanel({ failure, repairs }: { failure?: FailureDetail; repairs?: RepairRecord[] }) {
  if (!failure) return null;
  const latest = repairs?.[repairs.length - 1];
  const where = latest?.service ? ` (${latest.service})` : '';

  return (
    <section data-testid="retry-panel" className="m-4 rounded-lg border border-warn/60 bg-panel p-4 text-[13px]">
      <div className="mb-2 flex items-center gap-2">
        <span className="rounded-full border border-warn px-2 py-0.5 text-[11px] text-warn">retrying</span>
        <span className="text-muted">the run is still going</span>
      </div>
      <p>{explain(failure, latest, where)}</p>
    </section>
  );
}

function explain(failure: FailureDetail, latest: RepairRecord | undefined, where: string): string {
  const mb = (v: unknown) => (typeof v === 'number' ? `${v} MB` : undefined);
  if (latest?.type === 'MEMORY_LIMIT_RAISED') {
    const before = mb(latest.before.memoryMb) ?? mb(failure.memory?.limitMb);
    const after = mb(latest.after.memoryMb);
    return `The last try${where} ran out of memory${before ? ` at ${before}` : ''}. Trying again with ${after ?? 'more memory'}…`;
  }
  if (latest?.type === 'NODE_HEAP_RAISED') {
    const after = mb(latest.after.nodeHeapMb);
    return `The last try${where} ran out of Node.js memory. Trying again with a bigger Node.js heap${after ? ` (${after})` : ''}…`;
  }
  if (latest) {
    return `The last try${where} failed: ${failure.message} Trying again with a fix…`;
  }
  return `The last try failed: ${failure.message} Working out a fix…`;
}

/**
 * A session that has not ended, so a failure on it is the reason for a retry rather than
 * the result. Waiting for input is not running: nothing is retrying until somebody answers.
 */
export function stillRunning(state: string | undefined): boolean {
  return state !== undefined && !['READY', 'PARTIALLY_READY', 'FAILED', 'CANCELLED', 'COMPLETED', 'AWAITING_INPUT'].includes(state);
}
