import { Sentinel } from '@devlaunch/shared';

/**
 * A deployment's timeline: what happened, when, to which service, and how long it took.
 *
 * The log says all of this too, in prose, interleaved with every line the application
 * printed. Answering "what exactly went wrong, and when?" meant reading it. This is the
 * same story as structured events — kept bounded, persisted with the deployment, and
 * returned by the API. Commands are recorded; environment values never are, so a secret
 * cannot reach it through here.
 */
export type EventSeverity = 'info' | 'warn' | 'error';

export interface DeploymentEvent {
  at: number;
  /** Upper-case and stable, e.g. `INSTALL_STARTED`, `STATE_READY`, `REPAIR_APPLIED`. */
  event: string;
  severity: EventSeverity;
  phase?: 'clone' | 'analyze' | 'plan' | 'install' | 'build' | 'start' | 'readiness' | 'verify' | 'repair' | 'cleanup';
  service?: string;
  command?: string;
  exitCode?: number;
  durationMs?: number;
  attempt?: number;
  detail?: string;
  /**
   * On a state change, the state being left — `durationMs` is how long it lasted. Without
   * it the time spent waiting for readiness was filed under READY.
   */
  previous?: string;
}

/** Old events are dropped first; a deployment with more than this is a loop worth seeing. */
export const MAX_EVENTS = 1000;

export function recordEvent(
  list: DeploymentEvent[],
  event: Omit<DeploymentEvent, 'at'> & { at?: number },
): DeploymentEvent {
  const e: DeploymentEvent = { at: event.at ?? Date.now(), ...event } as DeploymentEvent;
  list.push(e);
  if (list.length > MAX_EVENTS) list.splice(0, list.length - MAX_EVENTS);
  return e;
}

/** The wrapper's phase markers, as timeline events. */
const SENTINEL_EVENTS: Record<string, { event: string; phase: 'install' | 'build' | 'start'; severity: EventSeverity; ends?: string }> = {
  [Sentinel.INSTALL_BEGIN]: { event: 'INSTALL_STARTED', phase: 'install', severity: 'info' },
  [Sentinel.INSTALL_OK]: { event: 'INSTALL_SUCCESS', phase: 'install', severity: 'info', ends: Sentinel.INSTALL_BEGIN },
  [Sentinel.INSTALL_FAIL]: { event: 'INSTALL_FAILED', phase: 'install', severity: 'error', ends: Sentinel.INSTALL_BEGIN },
  [Sentinel.BUILD_BEGIN]: { event: 'BUILD_STARTED', phase: 'build', severity: 'info' },
  [Sentinel.BUILD_OK]: { event: 'BUILD_SUCCESS', phase: 'build', severity: 'info', ends: Sentinel.BUILD_BEGIN },
  [Sentinel.BUILD_FAIL]: { event: 'BUILD_FAILED', phase: 'build', severity: 'error', ends: Sentinel.BUILD_BEGIN },
  [Sentinel.START_BEGIN]: { event: 'START_STARTED', phase: 'start', severity: 'info' },
};

/**
 * Turn one container's phase markers into events, with the duration of each phase.
 * Returns the listener, for a log that emits `sentinel` with the marker and its time.
 */
export function sentinelRecorder(
  list: DeploymentEvent[],
  service: string | undefined,
  onEvent?: (e: DeploymentEvent) => void,
): (marker: string, ts?: number) => void {
  const began = new Map<string, number>();
  return (marker, ts) => {
    const spec = SENTINEL_EVENTS[marker];
    if (!spec) return;
    const at = ts ?? Date.now();
    if (!spec.ends) began.set(marker, at);
    const start = spec.ends ? began.get(spec.ends) : undefined;
    const e = recordEvent(list, {
      at,
      event: spec.event,
      phase: spec.phase,
      severity: spec.severity,
      ...(service ? { service } : {}),
      ...(start !== undefined ? { durationMs: at - start } : {}),
    });
    onEvent?.(e);
  };
}

/** Time spent in each phase, summed across services and attempts, from the timeline. */
export function phaseDurations(events: readonly DeploymentEvent[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of events) {
    if (e.durationMs === undefined) continue;
    const key = e.previous ?? e.phase ?? e.event;
    out[key] = (out[key] ?? 0) + e.durationMs;
  }
  return out;
}
