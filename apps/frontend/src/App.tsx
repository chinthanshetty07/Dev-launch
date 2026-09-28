import { useCallback, useEffect, useState } from 'react';
import type { ServiceStats } from '@devlaunch/shared';
import { api, ConflictError } from './api';
import { useSession } from './useSession';
import { LaunchView } from './components/LaunchView';
import { RunHeader } from './components/RunHeader';
import { ResultHero, CompletedHero } from './components/ResultHero';
import { PipelineStrip } from './components/PipelineStrip';
import { ServicePanel } from './components/ServicePanel';
import { EndpointsPanel } from './components/EndpointsPanel';
import { PlanPanel } from './components/PlanPanel';
import { InputGate } from './components/InputGate';
import { FailurePanel } from './components/FailurePanel';
import { LogTerminal } from './components/LogTerminal';
import { Collapsible } from './components/Collapsible';
import { RewritePanel } from './components/RewritePanel';
import { BrowserWiringPanel } from './components/BrowserWiringPanel';

const RUNNING = [
  'QUEUED', 'CLONING', 'ANALYZING', 'PLANNING', 'VALIDATING',
  'AWAITING_INPUT', 'BUILDING', 'STARTING', 'WAITING_FOR_READY', 'REPAIRING', 'READY',
  'PARTIALLY_READY',
];

/**
 * One session, presented as the three things a person is actually doing: choosing what
 * to run, watching it run, and reading the result.
 *
 * Every panel used to render at once in a fixed stack, whatever the session was doing —
 * so a run that had not started yet showed empty panels, and a run that had finished
 * buried its URL under a plan, a warning list and several hundred lines of install
 * output. Nothing is hidden that was not, but what leads changes with what happened.
 */
export default function App() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<Record<string, ServiceStats>>({});
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

  const errorBanner = error && (
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
          className="rounded-md border border-bad px-2 py-0.5 text-[11px] hover:bg-bad/10"
        >
          Stop it
        </button>
      )}
      <button
        type="button"
        onClick={() => setError(null)}
        className="ml-auto text-[11px] text-muted hover:text-fg"
      >
        dismiss
      </button>
    </div>
  );

  if (!sessionId) {
    return (
      <div className="flex h-full flex-col overflow-auto">
        {errorBanner}
        <LaunchView busy={busy} onLaunch={launch} onOpenSession={setSessionId} />
      </div>
    );
  }

  const awaiting = state === 'AWAITING_INPUT' && session?.pending;
  const warnings = session?.planWarnings ?? [];

  return (
    <div className="flex h-full flex-col">
      <RunHeader
        state={state}
        repoUrl={session?.repoUrl}
        startedAt={session?.createdAt}
        readyAt={session?.readyAt}
        busy={busy}
        onStop={stop}
        onNew={() => {
          setSessionId(null);
          setError(null);
          setStats({});
        }}
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        {errorBanner}

        {/* The result leads, because it is what the pipeline exists to produce. A
            question the session is blocked on leads for the same reason: nothing else
            on the page can happen until it is answered. */}
        {awaiting && (
          <InputGate
            pending={session.pending!}
            busy={busy}
            onSubmitEnv={(env) => resolve({ env })}
            onChoose={(workspaceDir) => resolve({ workspaceDir })}
          />
        )}

        {(state === 'READY' || state === 'PARTIALLY_READY') && session?.url && (
          <ResultHero
            url={session.url}
            services={session.services}
            partial={state === 'PARTIALLY_READY'}
          />
        )}
        {/* Directly under the URL it qualifies. A green result above a page that does
            not work is worse than a failure, because a failure sends somebody looking. */}
        <BrowserWiringPanel problems={session?.browserProblems} />
        {state === 'COMPLETED' && <CompletedHero reason={session?.endedReason} />}
        {state === 'FAILED' && <FailurePanel failure={session?.failure} repairs={session?.repairs} />}

        {/* Above the plan and above the log, whatever the session is doing. Editing
            someone's repository is a real liberty, and the only thing that makes it a
            reasonable one is that it is impossible to miss. */}
        <RewritePanel rewrites={session?.rewrites} />

        {(state === 'READY' || state === 'PARTIALLY_READY') && (
          <EndpointsPanel url={session?.url} routes={session?.routes} readiness={session?.readiness} />
        )}

        {((session?.services?.length ?? 0) > 0 || (session?.backing?.length ?? 0) > 0) && (
          <ServicePanel
            services={session?.services ?? []}
            backing={session?.backing}
            stats={stats}
            onRestart={restart}
            busy={busy}
          />
        )}

        <PipelineStrip
          state={state}
          furthest={furthest}
          planSource={session?.plan?.planSource}
          detected={session?.detected}
        />

        {/* A failure that is not the headline still belongs on the page: a session can
            be CANCELLED or READY-after-repair and carry one worth reading. */}
        {state !== 'FAILED' && session?.failure && (
          <FailurePanel failure={session.failure} repairs={session.repairs} />
        )}

        {warnings.length > 0 && (
          <Collapsible
            title="Planning warnings"
            tone="warn"
            badge={`${warnings.length}`}
            defaultOpen={state === 'FAILED'}
          >
            <ul className="space-y-1 bg-panel px-4 py-3 text-[13px]">
              {warnings.map((w) => (
                <li key={w} className="text-warn">
                  {w}
                </li>
              ))}
            </ul>
          </Collapsible>
        )}

        {session?.plan && (
          <Collapsible title="Run plan" badge={session.plan.planSource}>
            <PlanPanel plan={session.plan} />
          </Collapsible>
        )}

        <LogTerminal lines={lines} connected={connected} grow={state !== 'READY' && state !== 'PARTIALLY_READY'} />
      </div>
    </div>
  );
}
