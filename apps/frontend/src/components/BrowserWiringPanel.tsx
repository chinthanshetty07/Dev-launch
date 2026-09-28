import type { BrowserWiringProblem } from '../api';

/**
 * Why the application you were just handed a link to will not work.
 *
 * Beside the URL, not below the log, and not behind a disclosure. A project can reach
 * READY in eight seconds, publish two real URLs and serve a page whose every request is
 * refused — and READY is an honest word for it: the containers are up and the ports are
 * open. What is not honest is stopping there. Two real repositories did exactly this,
 * and the only thing distinguishing them from a working run was a blank page nobody
 * could account for.
 *
 * The remedy is always a line in the repository, because that is always where the
 * problem is: a literal address no environment variable reaches. So the panel's job is
 * to name the file and both addresses — the one written down and the one that is real.
 */
export function BrowserWiringPanel({ problems }: { problems?: BrowserWiringProblem[] }) {
  if (!problems || problems.length === 0) return null;

  return (
    <section className="border-b border-warn/40 bg-warn/5 px-4 py-3 text-[13px]">
      <h2 className="mb-1 text-[11px] uppercase tracking-[0.15em] text-warn">
        Running, but the page will not reach its API
      </h2>
      <p className="mb-2 text-muted">
        Every service started and every URL above is real. These addresses are written
        into the source as literals, so no environment variable or flag reaches them —
        and the browser resolves them on your machine, where they point at nothing.
      </p>
      <ul className="space-y-2">
        {problems.map((p, i) => (
          <li key={`${p.service}-${i}`}>
            <div>
              <span className="text-warn">{p.service}</span>
              {p.file && <code className="ml-2 text-muted">{p.file}</code>}
            </div>
            <div className="pl-3">
              <div className="break-all text-muted">
                <span className="select-none text-bad">written </span>
                {p.expected}
              </div>
              <div className="break-all">
                <span className="select-none text-ok">actual&nbsp; </span>
                {p.actual}
              </div>
              <p className="text-[12px] text-muted">{p.problem}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
