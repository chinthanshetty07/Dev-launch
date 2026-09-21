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
  // Any answer that is not a success, not just 404. A 403 is more alarming and less
  // self-explanatory than a missing page, and special-casing one status left the other
  // showing a bare URL that refuses every request a browser makes.
  const unexpected = readiness?.healthHintOk === false ? readiness : undefined;
  if (list.length === 0 && !unexpected) return null;

  const base = (url ?? '').replace(/\/+$/, '');
  const openable = (r: HttpRoute): boolean => r.method === 'GET' && !/[:{}<>*]/.test(r.path);

  return (
    <section className="border-b border-edge bg-panel px-4 py-3 text-[13px]">
      {unexpected && <RootNotice readiness={unexpected} hasRoutes={list.length > 0} />}
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

/**
 * Why the URL does not answer the way a person expects.
 *
 * The application is running — readiness only reports a status because something
 * answered. What it said is the useful part, and it is nearly always self-explanatory
 * once shown: an API has no page at `/`, or it refuses plain HTTP and says so in the
 * body. Neither reads as "working" behind a bare link.
 */
function RootNotice({ readiness, hasRoutes }: { readiness: ReadinessView; hasRoutes: boolean }) {
  const { status, path, body, logError } = readiness;
  const httpsOnly = status === 403 && /https/i.test(body ?? '');

  return (
    <div className="mb-2 text-muted">
      <p>
        <code>{path}</code> answered <span className="text-warn">{status}</span>
        {status === 404
          ? ': this application has no page there.'
          : httpsOnly
            ? ': this application refuses plain HTTP.'
            : ', which is not a success.'}{' '}
        It is running{hasRoutes ? ' — these are the routes it declares.' : '.'}
      </p>
      {body && <pre className="mt-1 overflow-x-auto rounded border border-edge bg-ink p-2">{body}</pre>}
      {/* The page says "Internal Server Error"; the log says which table is missing. */}
      {logError && (
        <p className="mt-1">
          <span className="text-muted">its log says: </span>
          <code className="text-warn">{logError}</code>
        </p>
      )}
      {httpsOnly && (
        <p className="mt-1">
          DevLaunch publishes over HTTP, so every request is refused — including the browser&apos;s.
          A repository that enforces HTTPS usually ships a certificate and expects to be started
          with one (for uvicorn, <code>--ssl-keyfile</code> and <code>--ssl-certfile</code>).
        </p>
      )}
    </div>
  );
}
