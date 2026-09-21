import { useEffect, useState } from 'react';
import { api, type SessionSummary } from '../api';

/**
 * The first thing a person sees, and for a while the only thing.
 *
 * It used to be one bare input wedged into the header beside a fixture dropdown, with
 * every panel of a run that had not happened yet stacked empty underneath it. Nothing
 * said what to paste, what would happen, or how long it would take. This does, and it
 * keeps the fixture picker — which is a developer's tool, not a first-run one — behind
 * a disclosure rather than beside the field most people want.
 */

/** Real, small, public repositories that exercise different shapes of project. */
const EXAMPLES = [
  { label: 'Flask + SQLite', url: 'https://github.com/pj8912/todo-app' },
  { label: 'Express + SQLite', url: 'https://github.com/manoj2304s/express-sqlite-api' },
  { label: 'FastAPI', url: 'https://github.com/nkwus/fastapi-starter' },
];

const GITHUB_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/;

export function LaunchView({
  busy,
  onLaunch,
  onOpenSession,
}: {
  busy: boolean;
  onLaunch: (body: { repoUrl?: string; fixture?: string }) => void;
  onOpenSession: (id: string) => void;
}) {
  const [repoUrl, setRepoUrl] = useState('');
  const [fixture, setFixture] = useState('');
  const [fixtures, setFixtures] = useState<string[]>([]);
  const [showFixtures, setShowFixtures] = useState(false);
  const [recent, setRecent] = useState<SessionSummary[]>([]);

  useEffect(() => {
    api
      .fixtures()
      .then((list) => {
        setFixtures(list);
        setFixture((f) => f || (list.includes('node-http-basic') ? 'node-http-basic' : (list[0] ?? '')));
      })
      .catch(() => undefined);
    api
      .sessions()
      .then((all) => setRecent(all.slice(0, 6)))
      .catch(() => undefined);
  }, []);

  const trimmed = repoUrl.trim();
  // Only a complaint once there is something to complain about. Marking an empty field
  // invalid the moment the page loads is noise, not help.
  const malformed = trimmed !== '' && !GITHUB_URL.test(trimmed.replace(/\.git$/, ''));

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (malformed) return;
    onLaunch(trimmed ? { repoUrl: trimmed } : { fixture });
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-12">
      <h1 className="text-[22px] font-semibold tracking-tight">Run a GitHub project locally</h1>
      <p className="mt-2 max-w-xl text-[13px] leading-6 text-muted">
        Paste a public repository URL. DevLaunch reads how it is put together, works out
        how to install and start it, runs it in a locked-down container, and hands you a
        URL when it answers. Nothing is installed on your machine.
      </p>

      <form onSubmit={submit} className="mt-7">
        <label htmlFor="repo-url" className="mb-2 block text-[11px] uppercase tracking-[0.15em] text-muted">
          Repository URL
        </label>
        <div className="flex flex-wrap gap-2">
          <input
            id="repo-url"
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            placeholder="https://github.com/owner/repo"
            spellCheck={false}
            autoComplete="off"
            aria-invalid={malformed}
            aria-describedby={malformed ? 'repo-url-error' : undefined}
            className={`min-w-0 flex-1 rounded-md border bg-panel px-3 py-2.5 text-[13px] outline-none ${
              malformed ? 'border-bad focus:border-bad' : 'border-edge focus:border-link'
            }`}
          />
          <button
            type="submit"
            disabled={busy || malformed}
            className="rounded-md border border-link bg-link/10 px-5 py-2.5 text-[13px] font-medium text-link hover:bg-link/20 disabled:opacity-40"
          >
            {busy ? 'Starting…' : 'Run it'}
          </button>
        </div>
        {malformed && (
          <p id="repo-url-error" className="mt-2 text-[12px] text-bad">
            That is not a github.com repository URL. It should look like{' '}
            <code>https://github.com/owner/repo</code>.
          </p>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px]">
          <span className="text-muted">Try one:</span>
          {EXAMPLES.map((ex) => (
            <button
              key={ex.url}
              type="button"
              onClick={() => setRepoUrl(ex.url)}
              className="rounded-full border border-edge px-3 py-1 text-muted hover:border-link hover:text-link"
            >
              {ex.label}
            </button>
          ))}
        </div>
      </form>

      {recent.length > 0 && (
        <div className="mt-10">
          <h2 className="mb-2 text-[11px] uppercase tracking-[0.15em] text-muted">Recent runs</h2>
          <ul className="divide-y divide-edge rounded-md border border-edge">
            {recent.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => onOpenSession(s.id)}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left text-[13px] hover:bg-panel"
                >
                  <StateDot state={s.state} />
                  <span className="min-w-0 flex-1 truncate">{shortRepo(s.repoUrl) ?? 'local fixture'}</span>
                  {s.active && <span className="text-[11px] text-link">running</span>}
                  <span className="text-[11px] text-muted">{when(s.createdAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-10">
        <button
          type="button"
          onClick={() => setShowFixtures((v) => !v)}
          aria-expanded={showFixtures}
          className="text-[12px] text-muted hover:text-link"
        >
          {showFixtures ? '▾' : '▸'} Run a bundled test fixture instead
        </button>
        {showFixtures && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <p className="w-full text-[12px] leading-5 text-muted">
              Small local projects used to exercise the engine, including ones that fail
              on purpose. Cloning only accepts public github.com URLs, so these are the
              only way to reach those paths.
            </p>
            <select
              value={fixture}
              onChange={(e) => setFixture(e.target.value)}
              aria-label="Fixture"
              className="rounded-md border border-edge bg-panel px-3 py-2 text-[13px] outline-none focus:border-link"
            >
              {fixtures.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={busy || !fixture}
              onClick={() => onLaunch({ fixture })}
              className="rounded-md border border-edge px-4 py-2 text-[13px] hover:border-link hover:text-link disabled:opacity-40"
            >
              Run fixture
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const DOT: Record<string, string> = {
  READY: 'bg-ok',
  COMPLETED: 'bg-ok',
  FAILED: 'bg-bad',
  CANCELLED: 'bg-muted',
};

function StateDot({ state }: { state: string }): React.ReactElement {
  return (
    <span
      aria-label={state.toLowerCase()}
      title={state.toLowerCase()}
      className={`h-2 w-2 shrink-0 rounded-full ${DOT[state] ?? 'bg-link'}`}
    />
  );
}

/** `owner/repo`, which is what a person recognises; the rest of the URL is boilerplate. */
export function shortRepo(url?: string): string | undefined {
  if (!url) return undefined;
  const m = /github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url);
  return m?.[1] ?? url;
}

function when(ts: number): string {
  const mins = Math.round((Date.now() - ts) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(ts).toLocaleDateString();
}
