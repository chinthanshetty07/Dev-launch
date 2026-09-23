import type { SourceRewrite } from '../api';

/**
 * What DevLaunch changed in the code, when it was allowed to change anything.
 *
 * Shown unprompted and above the fold, not folded away with the plan. Editing someone's
 * repository to make it run is a real liberty, and the only thing that makes it a
 * reasonable one is that it is small, explained, and impossible to miss. A person who
 * scrolls past this and later wonders why their proxy target looks different has been
 * failed by the tool, not by their attention.
 */
export function RewritePanel({ rewrites }: { rewrites?: SourceRewrite[] }) {
  if (!rewrites || rewrites.length === 0) return null;

  return (
    <section className="border-b border-warn/40 bg-warn/5 px-4 py-3 text-[13px]">
      <h2 className="mb-1 text-[11px] uppercase tracking-[0.15em] text-warn">
        Edited to make this run ({rewrites.length})
      </h2>
      <p className="mb-2 text-muted">
        <code>DEVLAUNCH_REWRITE_SOURCE</code> is set, so DevLaunch changed an address that
        is a literal in the source and could not be reached any other way. The edit is in
        the clone DevLaunch runs from, in a temporary directory —{' '}
        <strong className="text-fg">your own checkout is untouched</strong>. Unset the
        variable to have these reported instead of applied.
      </p>
      <ul className="space-y-2">
        {rewrites.map((r, i) => (
          <li key={`${r.file}-${i}`}>
            <code className="text-warn">{r.file}</code>
            <div className="pl-3">
              <div className="break-all text-muted">
                <span className="select-none text-bad">− </span>
                {r.from}
              </div>
              <div className="break-all">
                <span className="select-none text-ok">+ </span>
                {r.to}
              </div>
              <p className="text-[12px] text-muted">because {r.reason}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
