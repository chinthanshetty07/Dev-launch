import { useState } from 'react';
import type { PendingInput } from '../api';

/**
 * The question a session pauses to ask.
 *
 * Two kinds, both genuinely the user's to answer: configuration the project needs
 * before it can start, and which package to run in a monorepo. Guessing either would
 * produce a run that fails for a reason DevLaunch invented.
 */
export function InputGate({
  pending,
  busy,
  onSubmitEnv,
  onChoose,
}: {
  pending: PendingInput;
  busy: boolean;
  onSubmitEnv: (env: Record<string, string>) => void;
  onChoose: (dir: string) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});

  if (pending.choices && pending.choices.length > 0) {
    return (
      <section className="m-4 rounded-lg border border-warn/60 bg-panel p-4">
        <h2 className="mb-1 text-[13px] text-warn">Which package should run?</h2>
        <p className="mb-3 text-[13px] text-muted">
          This repository is a monorepo with more than one runnable package.
        </p>
        <div className="flex flex-wrap gap-2">
          {pending.choices.map((c) => (
            <button
              key={c.dir}
              type="button"
              disabled={busy}
              onClick={() => onChoose(c.dir)}
              className="rounded-md border border-edge px-3 py-2 text-[13px] hover:border-link hover:text-link disabled:opacity-50"
            >
              <span className="font-semibold">{c.name}</span>
              <span className="ml-2 text-muted">{c.dir}</span>
            </button>
          ))}
        </div>
      </section>
    );
  }

  if (pending.requiredEnv.length === 0) return null;

  return (
    <section className="m-4 rounded-lg border border-warn/60 bg-panel p-4">
      <h2 className="mb-1 text-[13px] text-warn">Configuration required</h2>
      <p className="mb-3 text-[13px] text-muted">
        These are declared in <code>.env.example</code> with no default — each beside the
        service that reads it. Values are held in memory for this session only and never
        written to disk. Anything DevLaunch supplies itself, such as the database URL and
        the services' own addresses, is not asked for.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmitEnv(values);
        }}
        className="space-y-2"
      >
        {pending.requiredEnv.map((v) => (
          <label key={`${v.service ?? ''}:${v.key}`} className="flex items-center gap-3 text-[13px]">
            <span className="w-44 shrink-0 text-muted">
              {v.key}
              {/* Which service asked. A project declares its configuration beside the
                  service that reads it, so the same key can mean different things in
                  two of them and a bare list of names would not say which is which. */}
              {v.service && <span className="ml-2 text-[11px] opacity-60">{v.service}</span>}
            </span>
            <input
              value={values[v.key] ?? ''}
              onChange={(e) => setValues((p) => ({ ...p, [v.key]: e.target.value }))}
              className="w-80 rounded-md border border-edge bg-ink px-2 py-1 outline-none focus:border-link"
            />
          </label>
        ))}
        <button
          type="submit"
          disabled={busy}
          className="mt-2 rounded-md border border-edge px-3 py-1.5 text-[13px] hover:border-link hover:text-link disabled:opacity-50"
        >
          Continue
        </button>
      </form>
    </section>
  );
}
