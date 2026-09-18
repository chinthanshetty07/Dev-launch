import { useCallback, useEffect, useState } from 'react';
import { api, ConflictError } from './api';
import { useSession } from './useSession';
import { RepoLauncher } from './components/RepoLauncher';
import { PipelineStrip } from './components/PipelineStrip';
import { ServicePanel } from './components/ServicePanel';
import { PlanPanel } from './components/PlanPanel';
import { InputGate } from './components/InputGate';
import { FailurePanel } from './components/FailurePanel';
import { LogTerminal } from './components/LogTerminal';

const RUNNING = ['QUEUED', 'CLONING', 'ANALYZING', 'PLANNING', 'VALIDATING', 'AWAITING_INPUT', 'BUILDING', 'STARTING', 'WAITING_FOR_READY', 'READY'];

export default function App() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<Record<string, import('@devlaunch/shared').ServiceStats>>({});
  /** A session blocking a launch, so it can be stopped from here rather than hunted for. */
  const [blockedBy, setBlockedBy] = useState<string | null>(null);

  /*
   * Reconnect to whatever is already running.
   *
   * The session id lived only in this component's state, so a page reload stranded a
   * running session: it kept its containers and the only slot, and nothing in the UI
   * could see it or stop it. Adopting it on load is what makes "a session is already
   * running" a thing a person can act on.
   */
  useEffect(() => {
    if (sessionId) return;
    api
      .sessions()
      .then((all) => {
        const running = all.find((s) => s.active);
        if (running) setSessionId(running.id);
      })
      .catch(() => undefined);
    // Only on mount: afterwards this component owns the session it started.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const { state, furthest, lines, session, connected, refresh } = useSession(sessionId);

  const launch = useCallback(async (body: { repoUrl?: string; fixture?: string }) => {
    setBusy(true);
    setError(null);
    setBlockedBy(null);
    try {
      const created = await api.launch(body);
      setSessionId(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      if (err instanceof ConflictError && err.activeSessionId) setBlockedBy(err.activeSessionId);
    } finally {
      setBusy(false);
    }
  }, []);

  const stop = useCallback(async () => {
    if (!sessionId) return;
    setBusy(true);
    try {
      await api.cancel(sessionId);
      refresh();
    } finally {
      setBusy(false);
    }
  }, [sessionId, refresh]);

  const restart = useCallback(
    async (service?: string) => {
      if (!sessionId) return;
      setBusy(true);
      setError(null);
      try {
        await api.restart(sessionId, service);
        refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [sessionId, refresh],
  );

  const resolve = useCallback(
    async (body: { env?: Record<string, string>; workspaceDir?: string }) => {
      if (!sessionId) return;
      setBusy(true);
      try {
        await api.resolve(sessionId, body);
        refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [sessionId, refresh],
  );

  const running = RUNNING.includes(state);

  // Polled only while something is running, and only when the project has services to
  // report on: sampling a finished session tells nobody anything.
  const hasServices = (session?.services?.length ?? 0) > 0;
  useEffect(() => {
    if (!sessionId || !running || !hasServices) return;
    let cancelled = false;
    const tick = () => {
      api
        .stats(sessionId)
        .then((s) => !cancelled && setStats(s))
        .catch(() => undefined);
    };
    tick();
    const timer = setInterval(tick, 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sessionId, running, hasServices]);

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-edge bg-panel">
        <div className="flex items-baseline gap-4 px-4 pt-3">
          <h1 className="text-[13px] font-semibold uppercase tracking-[0.2em]">DevLaunch</h1>
          <p className="text-[13px] text-muted">Run any supported GitHub project locally.</p>
          <span className="ml-auto text-[11px] text-muted">
            {state === 'IDLE' ? 'idle' : state.toLowerCase().replace(/_/g, ' ')}
          </span>
        </div>
        <RepoLauncher busy={busy} onLaunch={launch} onStop={stop} canStop={running} />
      </header>

      {error && (
        <div className="flex items-center gap-3 border-b border-bad/50 bg-panel px-4 py-2 text-[13px] text-bad">
          <span>{error}</span>
          {blockedBy && (
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api.cancel(blockedBy);
                  setBlockedBy(null);
                  setError(null);
                  setSessionId(null);
                } catch (err) {
                  setError(err instanceof Error ? err.message : String(err));
                } finally {
                  setBusy(false);
                }
              }}
              className="rounded-md border border-bad px-2 py-0.5 text-[11px] hover:bg-bad/10 disabled:opacity-40"
            >
              stop it
            </button>
          )}
        </div>
      )}

      <PipelineStrip
        state={state}
        furthest={furthest}
        planSource={session?.plan?.planSource}
        detected={session?.detected}
      />

      {/* A single-service session has no service table but can still have a database,
          and a database running unannounced is exactly the kind of thing a person finds
          later in `docker ps` and cannot account for. */}
      {((session?.services?.length ?? 0) > 0 || (session?.backing?.length ?? 0) > 0) && (
        <ServicePanel
          services={session?.services ?? []}
          backing={session?.backing}
          stats={stats}
          onRestart={restart}
          busy={busy}
        />
      )}

      {session?.state === 'AWAITING_INPUT' && session.pending && (
        <InputGate
          pending={session.pending}
          busy={busy}
          onSubmitEnv={(env) => resolve({ env })}
          onChoose={(workspaceDir) => resolve({ workspaceDir })}
        />
      )}

      {session?.url && state === 'READY' && (
        <section className="flex items-center gap-4 border-b border-ok/40 bg-panel px-4 py-3">
          <span className="text-[13px] text-muted">Application</span>
          <a
            href={session.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[13px] text-link underline-offset-4 hover:underline"
          >
            {session.url}
          </a>
          <a
            href={session.url}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto rounded-md border border-ok/60 px-3 py-1.5 text-[13px] text-ok hover:bg-ok/10"
          >
            Open Application
          </a>
        </section>
      )}

      <FailurePanel failure={session?.failure} />
      <PlanPanel plan={session?.plan} warnings={session?.planWarnings} />
      <LogTerminal lines={lines} connected={connected} />
    </div>
  );
}
