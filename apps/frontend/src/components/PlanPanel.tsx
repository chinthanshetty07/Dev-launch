import type { RunPlan } from '@devlaunch/shared';

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <div className="flex gap-3 py-0.5">
      <dt className="w-36 shrink-0 text-muted">{label}</dt>
      <dd className="break-all">{value}</dd>
    </div>
  );
}

/**
 * The plan, shown in full before and during execution.
 *
 * Displaying the resolved commands is deliberate: the allowlist constrains what
 * DevLaunch composes, not what a repository's own scripts do, so showing exactly what
 * will run turns that boundary into informed consent rather than a hidden assumption.
 */
export function PlanPanel({ plan }: { plan?: RunPlan }) {
  if (!plan) return null;

  const required = plan.environmentVariables.filter((v) => v.required);

  return (
    <section className="bg-panel px-4 py-3 text-[13px]">
      <dl>
        <Row label="runtime" value={`${plan.runtime.language} ${plan.runtime.version}`} />
        <Row label="package manager" value={plan.packageManager} />
        <Row label="install" value={<code>{plan.installCommand}</code>} />
        <Row label="build" value={plan.buildCommand ? <code>{plan.buildCommand}</code> : null} />
        <Row label="start" value={<code className="text-link">{plan.startCommand}</code>} />
        <Row label="working dir" value={plan.workingDirectory} />
        <Row label="port" value={plan.expectedPort} />
        <Row
          label="host binding"
          value={
            <span className={plan.hostBinding === 'forced' ? 'text-ok' : 'text-warn'}>
              {plan.hostBinding}
              {plan.hostBinding !== 'forced' && ' — may bind loopback'}
            </span>
          }
        />
        <Row
          label="environment"
          value={
            plan.environmentVariables.length > 0
              ? plan.environmentVariables
                  .map((v) => (v.value === null ? `${v.key}=?` : `${v.key}=${v.value}`))
                  .join('  ')
              : null
          }
        />
        <Row label="required" value={required.length > 0 ? required.map((v) => v.key).join(', ') : null} />
      </dl>

    </section>
  );
}
