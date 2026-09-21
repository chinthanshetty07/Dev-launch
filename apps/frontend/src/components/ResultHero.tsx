import { useState } from 'react';
import type { ServiceView } from '@devlaunch/shared';

/**
 * The answer, when there is one.
 *
 * A successful run's URL used to be a 13px link on a row between the service table and
 * the endpoint list, indistinguishable in weight from the plan and the warnings below
 * it. It is the one thing the entire pipeline exists to produce, so it is the one thing
 * that gets size here — and for a project with a frontend *and* an API, the page a
 * person wants is named as such rather than left to be guessed from two equal links.
 */
export function ResultHero({
  url,
  services,
}: {
  url: string;
  services?: ServiceView[];
}) {
  // Which of several URLs is the one to open. The browser-facing service is the page;
  // the API beside it is something the page calls, and opening it shows a 404 at best.
  const web = (services ?? []).find((s) => s.role === 'web' && s.url);
  const primary = web?.url ?? url;
  const others = (services ?? []).filter((s) => s.url && s.url !== primary);

  return (
    <section className="border-b border-ok/40 bg-ok/5 px-4 py-5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-[0.15em] text-ok">
            {web ? 'Your application is running' : 'Running'}
          </p>
          <a
            href={primary}
            target="_blank"
            rel="noopener noreferrer"
            className="block truncate text-[19px] text-link hover:underline"
          >
            {primary}
          </a>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <CopyButton value={primary} />
          <a
            href={primary}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-md border border-ok bg-ok/10 px-5 py-2.5 text-[13px] font-medium text-ok hover:bg-ok/20"
          >
            Open ↗
          </a>
        </div>
      </div>

      {others.length > 0 && (
        <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
          <span>Also published:</span>
          {others.map((s) => (
            <a
              key={s.name}
              href={s.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-link hover:underline"
            >
              {s.name} <span className="text-muted">({s.role === 'api' ? 'API' : s.role})</span>
            </a>
          ))}
        </p>
      )}
    </section>
  );
}

/**
 * Ran, exited 0, opened no port.
 *
 * Worth its own panel rather than an absence: a CLI, a migration or a seeder finishing
 * is a success, and a page that simply shows no URL for it looks like the failure it is
 * not.
 */
export function CompletedHero({ reason }: { reason?: string }) {
  return (
    <section className="border-b border-ok/40 bg-ok/5 px-4 py-5">
      <p className="text-[11px] uppercase tracking-[0.15em] text-ok">Finished</p>
      <p className="mt-1 text-[14px]">
        The program ran to completion and exited cleanly. It never opened a port, so
        there is nothing to open in a browser — which is the expected shape for a script,
        a migration or a command-line tool.
      </p>
      {reason && <p className="mt-1 text-[12px] text-muted">{reason}</p>}
      <p className="mt-2 text-[12px] text-muted">Its full output is in the log below.</p>
    </section>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={() => {
        // Not available on an insecure origin other than localhost; there is nothing
        // useful to do about that beyond not pretending it worked.
        navigator.clipboard
          ?.writeText(value)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => undefined);
      }}
      className="rounded-md border border-edge px-3 py-2.5 text-[12px] text-muted hover:border-link hover:text-link"
    >
      {copied ? 'Copied' : 'Copy URL'}
    </button>
  );
}
