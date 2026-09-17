import type { BackingView, ServiceStats, ServiceView } from '@devlaunch/shared';

const STATE_STYLE: Record<string, string> = {
  READY: 'border-ok/60 text-ok',
  FAILED: 'border-bad text-bad',
  CANCELLED: 'border-bad text-bad',
  STARTING: 'border-link text-link',
  BUILDING: 'border-link text-link',
  WAITING_FOR_READY: 'border-link text-link',
};

const ROLE_LABEL: Record<ServiceView['role'], string> = {
  web: 'browser',
  api: 'called by the page',
  worker: 'no port',
};

/**
 * Every part of a running project, with what it is doing and what it is consuming.
 *
 * A project has several of everything a single-service session had one of. The session's
 * own state can only ever say whether *all* of it is ready — which is the right gate and
 * the wrong amount of detail when one of four services is the problem.
 */
export function ServicePanel({
  services,
  backing,
  stats,
  onRestart,
  busy,
}: {
  services: ServiceView[];
  backing?: BackingView[];
  stats?: Record<string, ServiceStats>;
  onRestart: (service?: string) => void;
  busy: boolean;
}) {
  if (services.length === 0) return null;

  return (
    <section className="border-b border-edge bg-panel px-4 py-3">
      <div className="mb-2 flex items-center gap-3">
        <h2 className="text-[11px] uppercase tracking-[0.15em] text-muted">Services</h2>
        <button
          type="button"
          onClick={() => onRestart()}
          disabled={busy}
          className="rounded-md border border-edge px-2 py-0.5 text-[11px] hover:border-link hover:text-link disabled:opacity-40"
        >
          restart all
        </button>
      </div>

      <table className="w-full text-[13px]">
        <tbody>
          {services.map((service) => (
            <tr key={service.name} className="align-middle">
              <td className="py-1 pr-3 font-medium">{service.name}</td>
              <td className="py-1 pr-3 text-muted">{ROLE_LABEL[service.role]}</td>
              <td className="py-1 pr-3">
                <span
                  className={`rounded-md border px-2 py-0.5 text-[11px] ${
                    STATE_STYLE[service.state] ?? 'border-edge text-muted'
                  }`}
                >
                  {service.state.toLowerCase().replace(/_/g, ' ')}
                </span>
              </td>
              <td className="py-1 pr-3 text-muted">
                {service.hostPort ? (
                  <span title="host port → container port">
                    {service.hostPort} → {service.containerPort}
                  </span>
                ) : (
                  '—'
                )}
              </td>
              <td className="py-1 pr-3">
                {service.url ? (
                  <a className="text-link hover:underline" href={service.url} target="_blank" rel="noreferrer">
                    {service.url}
                  </a>
                ) : (
                  <span className="text-muted">—</span>
                )}
              </td>
              <td className="py-1 pr-3 text-right tabular-nums text-muted">
                <Usage stats={stats?.[service.name]} />
              </td>
              <td className="py-1 text-right">
                <button
                  type="button"
                  onClick={() => onRestart(service.name)}
                  disabled={busy}
                  className="rounded-md border border-edge px-2 py-0.5 text-[11px] hover:border-link hover:text-link disabled:opacity-40"
                >
                  restart
                </button>
              </td>
            </tr>
          ))}

          {(backing ?? []).map((db) => (
            <tr key={db.kind} className="align-middle">
              <td className="py-1 pr-3 font-medium">{db.alias}</td>
              {/* Provisioned by DevLaunch rather than found in the repository, and worth
                  saying so: it is not something the user can look for in their own code. */}
              <td className="py-1 pr-3 text-muted">provisioned {db.kind}</td>
              <td className="py-1 pr-3">
                <span
                  className={`rounded-md border px-2 py-0.5 text-[11px] ${
                    db.ready ? STATE_STYLE.READY : 'border-edge text-muted'
                  }`}
                >
                  {db.ready ? 'ready' : 'starting'}
                </span>
              </td>
              <td className="py-1 pr-3 text-muted">internal</td>
              <td className="py-1 pr-3 text-muted">reachable as {db.alias}</td>
              <td className="py-1 pr-3 text-right tabular-nums text-muted">
                <Usage stats={stats?.[db.kind]} />
              </td>
              <td />
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** CPU and memory, or nothing at all rather than a zero that looks like a measurement. */
function Usage({ stats }: { stats?: ServiceStats }) {
  if (!stats) return <span className="text-muted">—</span>;
  const mb = (stats.memoryBytes / 1024 / 1024).toFixed(0);
  const limit = stats.memoryLimitBytes ? `/${(stats.memoryLimitBytes / 1024 / 1024).toFixed(0)}` : '';
  return (
    <span title={`sampled ${new Date(stats.sampledAt).toLocaleTimeString()}`}>
      {stats.cpuPercent.toFixed(0)}% cpu · {mb}
      {limit} MB
    </span>
  );
}
