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

  if (pending.crash) {
    return <CrashQuestion pending={pending} crash={pending.crash} busy={busy} onSubmitEnv={onSubmitEnv} />;
  }

  return (
    <section className="m-4 rounded-lg border border-warn/60 bg-panel p-4">
      <h2 className="mb-1 text-[13px] text-warn">Configuration required</h2>
      <p className="mb-3 text-[13px] text-muted">
        These are declared in <code>.env.example</code> with no default — each beside the
        service that reads it. Values are held in memory for this session only and never
        written to disk. Anything DevLaunch supplies itself, such as the database URL and
        the services' own addresses, is not asked for.
      </p>
      {/* A file cannot always say which of its variables the application truly needs, so
          the gate asks and does not insist. Leaving one blank and continuing is a
          legitimate answer, and saying so beats a person hunting for a key the project
          may not use. */}
      <p className="mb-3 text-[13px] text-muted">
        Leave anything blank that this project does not need — the run continues without
        it, and fails with the application's own error if it turns out to be required.
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
              {v.kind && <span className="block text-[11px] opacity-70">{KIND_LABEL[v.kind]}</span>}
            </span>
            <input
              type={v.kind === 'REQUIRED_SECRET' || v.kind === 'EXTERNAL_SERVICE_REQUIRED' ? 'password' : 'text'}
              autoComplete="off"
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
          {Object.values(values).some((v) => v.trim() !== '') ? 'Continue' : 'Continue without these'}
        </button>
      </form>
    </section>
  );
}

/**
 * A stand-in for a setting the person does not have. Enough for an app that only checks
 * that a key exists before starting (a payment client built when the file loads); the
 * feature that uses it fails when used, which is what "start without it" means.
 */
export const STAND_IN = 'not-set-devlaunch-placeholder';

/**
 * The question after a crash: the app stopped on settings nobody gave it. Not "continue
 * without these" with blanks — that is the crash again — but the values, or stand-ins.
 */
export function CrashQuestion({
  pending,
  crash,
  busy,
  onSubmitEnv,
}: {
  pending: PendingInput;
  crash: NonNullable<PendingInput['crash']>;
  busy: boolean;
  onSubmitEnv: (env: Record<string, string>) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const keys = pending.requiredEnv.map((v) => v.key);
  const one = keys.length === 1;
  const filled = keys.every((k) => (values[k] ?? '').trim() !== '');

  return (
    <section className="m-4 rounded-lg border border-warn/60 bg-panel p-4">
      <h2 className="mb-1 text-[13px] text-warn">The app needs {one ? 'a setting' : 'some settings'} to start</h2>
      <p className="mb-2 text-[13px] text-muted">
        It stopped at <code>{crash.file}</code> line {crash.line}, which reads{' '}
        {keys.map((k, i) => (
          <span key={k}>
            {i > 0 && (i === keys.length - 1 ? ' and ' : ', ')}
            <code>{k}</code>
          </span>
        ))}
        . Nothing set {one ? 'it' : 'them'}, and DevLaunch cannot make up your own keys.
      </p>
      {crash.error && <p className="mb-3 break-words font-mono text-[12px] text-bad">{crash.error}</p>}
      <p className="mb-3 text-[13px] text-muted">
        Enter {one ? 'it' : 'them'} to start again. Values stay in memory for this run only and are never
        written to disk. No {one ? 'key' : 'keys'}? Start without: DevLaunch fills in a stand-in so the app
        can start, and only the part that uses {one ? 'it' : 'them'} will not work.
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
              {v.service && <span className="ml-2 text-[11px] opacity-60">{v.service}</span>}
              {v.kind && <span className="block text-[11px] opacity-70">{KIND_LABEL[v.kind]}</span>}
            </span>
            <input
              type={v.kind === 'REQUIRED_SECRET' || v.kind === 'EXTERNAL_SERVICE_REQUIRED' ? 'password' : 'text'}
              autoComplete="off"
              value={values[v.key] ?? ''}
              onChange={(e) => setValues((p) => ({ ...p, [v.key]: e.target.value }))}
              className="w-80 rounded-md border border-edge bg-ink px-2 py-1 outline-none focus:border-link"
            />
          </label>
        ))}
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="submit"
            disabled={busy || !filled}
            className="rounded-md border border-edge px-3 py-1.5 text-[13px] hover:border-link hover:text-link disabled:opacity-50"
          >
            Start with {one ? 'it' : 'these'}
          </button>
          {!filled && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onSubmitEnv(Object.fromEntries(keys.map((k) => [k, (values[k] ?? '').trim() || STAND_IN])))}
              className="rounded-md border border-edge px-3 py-1.5 text-[13px] text-muted hover:border-link hover:text-link disabled:opacity-50"
            >
              Start without {one ? 'it' : 'the missing ones'}
            </button>
          )}
        </div>
      </form>
    </section>
  );
}

/** What each kind of variable is, in a few plain words. */
const KIND_LABEL: Record<string, string> = {
  EXTERNAL_SERVICE_REQUIRED: 'a key from an outside service — only you can get it',
  REQUIRED_SECRET: 'a secret, such as a password or token',
  REQUIRED_CONFIGURATION: 'a setting with no default',
  OPTIONAL_CONFIGURATION: 'optional',
  AUTO_GENERATABLE_VALUE: 'generated for you',
};
