import type { HttpRoute, ReadinessView } from '@devlaunch/shared';

/**
 * What there is to open, when the URL alone is not it.
 *
 * An API reaches READY and its root returns 404, because an API has no page at `/`. A
 * person handed that URL sees "Cannot GET /" and concludes the run is broken, when the
 * application is running perfectly and the routes it serves were in its source all
 * along. This says so, and lists them.
 */
const METHOD_STYLE: Record<string, string> = {
  GET: 'border-ok/60 text-ok',
  POST: 'border-link text-link',
  PUT: 'border-warn text-warn',
  PATCH: 'border-warn text-warn',
  DELETE: 'border-bad text-bad',
};

export function EndpointsPanel({
  url,
  routes,
  readiness,
}: {
  url?: string;
  routes?: HttpRoute[];
  readiness?: ReadinessView;
}) {
  const list = routes ?? [];
  const rootMissing = readiness?.status === 404;
  if (list.length === 0 && !rootMissing) return null;

  const base = (url ?? '').replace(/\/+$/, '');
  const openable = (r: HttpRoute): boolean => r.method === 'GET' && !/[:{}<>*]/.test(r.path);

  return (
    <section className="border-b border-edge bg-panel px-4 py-3 text-[13px]">
      {rootMissing && (
        <p className="mb-2 text-muted">
          The root path <code>{readiness?.path ?? '/'}</code> returned 404: this application has no
          page there. It is running{list.length > 0 ? ' — these are the routes it declares.' : '.'}
        </p>
      )}
      {list.length > 0 && (
        <>
          <h2 className="mb-1 text-[11px] uppercase tracking-[0.15em] text-muted">Endpoints</h2>
          <ul className="grid gap-1 sm:grid-cols-2">
            {list.map((r) => (
              <li key={`${r.method} ${r.path}`} className="flex items-center gap-2">
                <span className={`w-14 rounded-md border px-1.5 py-0.5 text-center text-[11px] ${METHOD_STYLE[r.method] ?? 'border-edge text-muted'}`}>
                  {r.method}
                </span>
                {openable(r) && base ? (
                  <a className="text-link hover:underline" href={`${base}${r.path}`} target="_blank" rel="noreferrer">
                    {r.path}
                  </a>
                ) : (
                  <span title={`from ${r.source}`}>{r.path}</span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
