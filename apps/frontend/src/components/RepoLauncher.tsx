import { useEffect, useState } from 'react';
import { api } from '../api';

/**
 * A GitHub URL, or one of the vendored fixtures.
 *
 * Fixtures are offered by name because repository cloning only accepts public
 * github.com URLs — the fixtures exist to exercise paths a public URL cannot reach,
 * such as a deliberate failure mode.
 */
export function RepoLauncher({
  busy,
  onLaunch,
  onStop,
  canStop,
}: {
  busy: boolean;
  onLaunch: (body: { repoUrl?: string; fixture?: string }) => void;
  onStop: () => void;
  canStop: boolean;
}) {
  const [repoUrl, setRepoUrl] = useState('');
  const [fixture, setFixture] = useState('');
  const [fixtures, setFixtures] = useState<string[]>([]);

  useEffect(() => {
    api
      .fixtures()
      .then((list) => {
        setFixtures(list);
        setFixture((f) => f || (list.includes('node-http-basic') ? 'node-http-basic' : (list[0] ?? '')));
      })
      .catch(() => undefined);
  }, []);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const url = repoUrl.trim();
    onLaunch(url ? { repoUrl: url } : { fixture });
  };

  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2 px-4 py-3">
      <input
        value={repoUrl}
        onChange={(e) => setRepoUrl(e.target.value)}
        placeholder="https://github.com/owner/repo"
        spellCheck={false}
        className="w-96 rounded-md border border-edge bg-panel px-3 py-2 text-[13px] outline-none focus:border-link"
      />
      <span className="text-[13px] text-muted">or</span>
      <select
        value={fixture}
        onChange={(e) => setFixture(e.target.value)}
        disabled={repoUrl.trim() !== ''}
        className="rounded-md border border-edge bg-panel px-3 py-2 text-[13px] outline-none focus:border-link disabled:opacity-40"
      >
        {fixtures.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </select>

      <button
        type="submit"
        disabled={busy}
        className="rounded-md border border-edge px-4 py-2 text-[13px] hover:border-link hover:text-link disabled:opacity-40"
      >
        Launch Repository
      </button>
      <button
        type="button"
        onClick={onStop}
        disabled={!canStop}
        className="rounded-md border border-edge px-4 py-2 text-[13px] hover:border-bad hover:text-bad disabled:opacity-40"
      >
        Stop
      </button>
    </form>
  );
}
