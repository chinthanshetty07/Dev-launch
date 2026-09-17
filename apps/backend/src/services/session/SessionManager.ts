import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  ExecutionState,
  FailureCode,
  TERMINAL_STATES,
  type FailureDetail,
  type RunPlan,
} from '@devlaunch/shared';
import { config } from '../../config/index.js';
import { LogManager } from '../logs/LogManager.js';
import type { ExecutionManager, LaunchHandle } from '../execution/ExecutionManager.js';

export interface Session {
  id: string;
  state: ExecutionState;
  plan: RunPlan;
  logs: LogManager;
  createdAt: number;
  /** When the application became reachable; starts the session lifetime clock. */
  readyAt?: number;
  url?: string;
  failure?: FailureDetail;
  handle?: LaunchHandle;
}

export interface LaunchRequest {
  plan: RunPlan;
  sourceDir: string;
  image: string;
  readinessTimeoutMs?: number;
}

export class SessionConflict extends Error {}

/**
 * In-memory session registry.
 *
 * Deliberately not backed by a database: this is a single-user local tool running one
 * session at a time, so sessions dying with the process is correct behaviour rather
 * than a limitation to work around.
 *
 * Owns the **session lifetime clock**, which is separate from the time-to-ready budget.
 * The original plan had one ~10 minute timeout covering everything, which would have
 * killed a running application while someone was still using it.
 */
export class SessionManager extends EventEmitter {
  private readonly sessions = new Map<string, Session>();
  private readonly timers = new Map<string, NodeJS.Timeout[]>();

  constructor(private readonly exec: ExecutionManager) {
    super();
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(): Session[] {
    return [...this.sessions.values()];
  }

  private activeCount(): number {
    return this.list().filter((s) => !TERMINAL_STATES.includes(s.state)).length;
  }

  async launch(req: LaunchRequest): Promise<Session> {
    if (this.activeCount() >= config.concurrency.maxSessions) {
      throw new SessionConflict(
        `A session is already running. DevLaunch runs ${config.concurrency.maxSessions} ` +
          'at a time, because the Colima VM cannot safely host more.',
      );
    }

    const session: Session = {
      id: randomUUID(),
      state: ExecutionState.QUEUED,
      plan: req.plan,
      // Created here, before the container exists, so a client can attach immediately.
      logs: new LogManager(),
      createdAt: Date.now(),
    };
    this.sessions.set(session.id, session);

    // Deliberately not awaited: the caller gets an id straight away and follows
    // progress over the log stream.
    void this.run(session, req);
    return session;
  }

  private async run(session: Session, req: LaunchRequest): Promise<void> {
    try {
      this.setState(session, ExecutionState.STARTING);
      const handle = await this.exec.launch({
        sessionId: session.id,
        plan: req.plan,
        sourceDir: req.sourceDir,
        image: req.image,
        logs: session.logs,
      });
      session.handle = handle;

      this.setState(session, ExecutionState.WAITING_FOR_READY);
      const outcome = await handle.waitForReady(req.readinessTimeoutMs);

      if (outcome.state === ExecutionState.READY) {
        session.readyAt = Date.now();
        session.url = outcome.url;
        this.setState(session, ExecutionState.READY);
        this.armLifetime(session);
      } else {
        session.failure = outcome.failure;
        this.setState(session, ExecutionState.FAILED);
        await this.teardown(session);
      }
    } catch (err) {
      session.failure = {
        code: FailureCode.UNKNOWN_RUNTIME_ERROR,
        message: err instanceof Error ? err.message : String(err),
      };
      this.setState(session, ExecutionState.FAILED);
      await this.teardown(session);
    }
  }

  /**
   * Start the session lifetime clock, which only begins once the app is READY.
   *
   * A hard cap bounds the session; the idle timer bounds neglect. Both stop a forgotten
   * container running indefinitely without cutting short an app in active use.
   */
  private armLifetime(session: Session): void {
    const timers: NodeJS.Timeout[] = [
      setTimeout(() => void this.stop(session.id, 'idle timeout'), config.timeouts.sessionIdleMs),
      setTimeout(() => void this.stop(session.id, 'maximum session lifetime'), config.timeouts.sessionHardCapMs),
    ];
    for (const t of timers) t.unref?.();
    this.timers.set(session.id, timers);
  }

  /** Reset the idle clock. Called when a client interacts with the session. */
  touch(id: string): void {
    const session = this.sessions.get(id);
    if (!session || session.state !== ExecutionState.READY) return;
    this.clearTimers(id);
    this.armLifetime(session);
  }

  async stop(id: string, reason = 'stopped'): Promise<void> {
    const session = this.sessions.get(id);
    if (!session || TERMINAL_STATES.includes(session.state)) return;
    session.failure = undefined;
    this.setState(session, ExecutionState.CLEANING_UP);
    await this.teardown(session);
    this.setState(session, ExecutionState.COMPLETED, reason);
  }

  async cancel(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session || TERMINAL_STATES.includes(session.state)) return;
    this.setState(session, ExecutionState.CLEANING_UP);
    await this.teardown(session);
    this.setState(session, ExecutionState.CANCELLED);
  }

  private async teardown(session: Session): Promise<void> {
    this.clearTimers(session.id);
    try {
      await session.handle?.cleanup();
    } catch {
      // Cleanup errors must never mask the state transition that caused teardown.
    }
  }

  private clearTimers(id: string): void {
    for (const t of this.timers.get(id) ?? []) clearTimeout(t);
    this.timers.delete(id);
  }

  private setState(session: Session, state: ExecutionState, reason?: string): void {
    session.state = state;
    this.emit('state', session, reason);
  }

  /** Release every session. Used on shutdown and between tests. */
  async shutdown(): Promise<void> {
    await Promise.all(this.list().map((s) => this.cancel(s.id)));
    this.sessions.clear();
  }
}
