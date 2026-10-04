import type { VerificationView } from '../api';

/**
 * What READY was based on: every end-to-end check, passed or not, and what it saw.
 *
 * A green light is a claim. This is the evidence for it — each service answering, the
 * frontend's API address answering, each database reachable from inside the services —
 * so a person can see what was actually verified instead of trusting a colour.
 */
export function VerificationPanel({ verification }: { verification?: VerificationView }) {
  if (!verification || verification.checks.length === 0) return null;
  const failed = verification.checks.filter((c) => !c.passed && !c.skipped).length;
  return (
    <section data-testid="verification" className={`m-4 rounded-lg border bg-panel p-4 text-[13px] ${verification.passed ? 'border-edge' : 'border-bad/60'}`}>
      <div className="mb-2 flex items-center gap-2">
        <span className={`rounded-full border px-2 py-0.5 text-[11px] ${verification.passed ? 'border-ok text-ok' : 'border-bad text-bad'}`}>
          {verification.passed ? 'end-to-end check passed' : `end-to-end check failed (${failed})`}
        </span>
        <span className="text-muted">{verification.checks.length} check{verification.checks.length === 1 ? '' : 's'} · {Math.round(verification.durationMs / 100) / 10}s</span>
      </div>
      <ul className="space-y-1">
        {verification.checks.map((c) => (
          <li key={`${c.kind}:${c.name}`} className="flex gap-2">
            <span className={c.skipped ? 'text-muted' : c.passed ? 'text-ok' : 'text-bad'}>
              {c.skipped ? '–' : c.passed ? '✓' : '✗'}
            </span>
            <span>
              {c.name}
              <span className="ml-2 text-muted">{c.skipped ? `not run: ${c.detail}` : c.detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
