import type { BackingView, ServiceStats, ServiceView } from '@devlaunch/shared';

const STATE_STYLE: Record<string, string> = {
  READY: 'border-ok/60 text-ok',
  PARTIALLY_READY: 'border-warn text-warn',
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
  canRestart,
}: {
  services: ServiceView[];
  backing?: BackingView[];
  stats?: Record<string, ServiceStats>;
  onRestart: (service?: string) => void;
  busy: boolean;
  /**
   * Whether the run is up (READY or partly). Restart is refused before that — the
   * server says why — so the buttons are not offered while it would be refused.
   */
  canRestart?: boolean;
}) {
  const restartOff = busy || canRestart === false;
  const restartTitle = canRestart === false ? 'Available once the run is up' : undefined;
  // Not `services.length === 0`: a single-service session has no service table and can
  // still have a database DevLaunch started on its behalf, which is worth showing.
  if (services.length === 0 && (backing?.length ?? 0) === 0) return null;

  return (
    <section className="border-b border-edge bg-panel px-4 py-3">
      <div className="mb-2 flex items-center gap-3">
        <h2 className="text-[11px] uppercase tracking-[0.15em] text-muted">
          {services.length > 0 ? 'Services' : 'Provisioned'}
        </h2>
        {services.length > 0 && (
          <button
            type="button"
            onClick={() => onRestart()}
            disabled={restartOff}
            title={restartTitle}
            className="rounded-md border border-edge px-2 py-0.5 text-[11px] hover:border-link hover:text-link disabled:opacity-40"
          >
            restart all
          </button>
        )}
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
                  disabled={restartOff}
                  title={restartTitle}
                  className="rounded-md border border-edge px-2 py-0.5 text-[11px] hover:border-link hover:text-link disabled:opacity-40"
                >
                  restart
                </button>
              </td>
            </tr>
          ))}

          {/* The commands, under the table rather than in it.
              A project's plan was never sent to the client at all — `session.plan` is
              the single-service field — so the "Run plan" disclosure was empty for every
              multi-service run, and `Start command exited with code 1` named no command.
              A row that failed is the row somebody is reading, so its commands are the
              ones worth the width. */}
          {services.some((sv) => sv.plan) && (
            <tr>
              <td colSpan={7} className="pt-2">
                <dl className="space-y-1 border-t border-edge pt-2 text-[12px]">
                  {services.filter((sv) => sv.plan).map((sv) => (
                    <div key={`${sv.name}-plan`} className="flex flex-wrap gap-x-3">
                      <dt className="text-muted">{sv.name}</dt>
                      <dd className="text-muted">
                        <code className="text-fg">{sv.plan!.startCommand}</code>
                        <span className="text-muted">
                          {' '}in {sv.plan!.workingDirectory} on {sv.plan!.runtime}
                          {sv.plan!.installCommand ? `, after ${sv.plan!.installCommand}` : ''}
                          {sv.plan!.buildCommand ? ` and ${sv.plan!.buildCommand}` : ''}
                        </span>
                      </dd>
                    </div>
                  ))}
                </dl>
              </td>
            </tr>
          )}

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
