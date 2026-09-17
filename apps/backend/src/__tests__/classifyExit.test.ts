import { describe, it, expect } from 'vitest';
import { ExecutionState, FailureCode, Sentinel, WrapperExit } from '@devlaunch/shared';
import {
  classifyExit,
  classifyPostReadyExit,
} from '../services/execution/ExecutionManager.js';

const seen = (...markers: string[]) => new Set(markers);

describe('classifyExit', () => {
  it('treats exit 0 as completed', () => {
    const r = classifyExit({ exitCode: 0, timedOut: false }, seen(Sentinel.START_BEGIN));
    expect(r.state).toBe(ExecutionState.COMPLETED);
    expect(r.failure).toBeUndefined();
  });

  it('classifies install failure from the wrapper exit code', () => {
    const r = classifyExit(
      { exitCode: WrapperExit.INSTALL_FAILED, timedOut: false },
      seen(Sentinel.INSTALL_BEGIN, Sentinel.INSTALL_FAIL),
    );
    expect(r.failure?.code).toBe(FailureCode.DEPENDENCY_INSTALL_FAILED);
    expect(r.phase).toBe('install');
  });

  it('classifies build failure', () => {
    const r = classifyExit(
      { exitCode: WrapperExit.BUILD_FAILED, timedOut: false },
      seen(Sentinel.INSTALL_BEGIN, Sentinel.INSTALL_OK, Sentinel.BUILD_BEGIN, Sentinel.BUILD_FAIL),
    );
    expect(r.failure?.code).toBe(FailureCode.BUILD_FAILED);
    expect(r.phase).toBe('build');
  });

  it("attributes an application's own exit code to the start phase", () => {
    // The wrapper execs the start command, so exit code 1 here belongs to the app.
    // Only the START_BEGIN sentinel reveals which phase it died in.
    const r = classifyExit(
      { exitCode: 1, timedOut: false },
      seen(Sentinel.INSTALL_BEGIN, Sentinel.INSTALL_OK, Sentinel.START_BEGIN),
    );
    expect(r.failure?.code).toBe(FailureCode.START_COMMAND_FAILED);
    expect(r.failure?.exitCode).toBe(1);
    expect(r.phase).toBe('start');
  });

  it('does not read wrapper exit codes once the application owns the process', () => {
    // The wrapper execs the start command and is then gone. An application that exits
    // 110 on its own must not be reported as a dependency install failure just because
    // 110 happens to be the wrapper's install-failure code.
    const r = classifyExit(
      { exitCode: WrapperExit.INSTALL_FAILED, timedOut: false },
      seen(Sentinel.INSTALL_BEGIN, Sentinel.INSTALL_OK, Sentinel.START_BEGIN),
    );
    expect(r.failure?.code).toBe(FailureCode.START_COMMAND_FAILED);
    expect(r.phase).toBe('start');
  });

  it('likewise does not mistake an app exit code for a build failure', () => {
    const r = classifyExit(
      { exitCode: WrapperExit.BUILD_FAILED, timedOut: false },
      seen(Sentinel.INSTALL_BEGIN, Sentinel.INSTALL_OK, Sentinel.START_BEGIN),
    );
    expect(r.failure?.code).toBe(FailureCode.START_COMMAND_FAILED);
  });

  it('does not mistake an app exit code for an install failure', () => {
    // An app exiting 110 after starting must not be read as a wrapper install failure.
    const r = classifyExit({ exitCode: 1, timedOut: false }, seen(Sentinel.START_BEGIN));
    expect(r.failure?.code).toBe(FailureCode.START_COMMAND_FAILED);
  });

  it('reports a timeout with the phase it was in', () => {
    const r = classifyExit(
      { exitCode: -1, timedOut: true },
      seen(Sentinel.INSTALL_BEGIN),
    );
    expect(r.failure?.code).toBe(FailureCode.PROCESS_TIMEOUT);
    expect(r.failure?.phase).toBe('install');
  });

  it('flags a missing working directory', () => {
    const r = classifyExit({ exitCode: WrapperExit.WORKDIR_MISSING, timedOut: false }, seen(Sentinel.FATAL));
    expect(r.failure?.code).toBe(FailureCode.CONTAINER_CREATE_FAILED);
  });

  it('falls back to UNKNOWN_RUNTIME_ERROR when no phase ever began', () => {
    const r = classifyExit({ exitCode: 127, timedOut: false }, seen());
    expect(r.failure?.code).toBe(FailureCode.UNKNOWN_RUNTIME_ERROR);
    expect(r.phase).toBe('none');
  });
});

describe('classifyPostReadyExit', () => {
  it('leaves a running container alone', () => {
    expect(classifyPostReadyExit({ kind: 'running' })).toBeNull();
  });

  it('does not end a session because the container could not be inspected', () => {
    // The decisive property. A Docker API hiccup is not evidence that an application
    // died, and reporting it as one would hand the user a confident, invented failure
    // — the same conflation that made exit-code attribution wrong before it was fixed.
    expect(classifyPostReadyExit({ kind: 'unknown', error: 'socket hang up' })).toBeNull();
  });

  it('reports a crash after readiness as APPLICATION_EXITED, not a start failure', () => {
    // START_COMMAND_FAILED would be wrong and actively misleading: the command was
    // right, it ran, and it served traffic. Only the tail of the log explains this.
    const v = classifyPostReadyExit({ kind: 'exited', exitCode: 1, oomKilled: false }, 'boom');
    expect(v?.state).toBe(ExecutionState.FAILED);
    expect(v?.failure?.code).toBe(FailureCode.APPLICATION_EXITED);
    expect(v?.failure?.exitCode).toBe(1);
    expect(v?.failure?.evidence).toBe('boom');
  });

  it('treats a clean exit as completion rather than failure', () => {
    const v = classifyPostReadyExit({ kind: 'exited', exitCode: 0, oomKilled: false });
    expect(v?.state).toBe(ExecutionState.COMPLETED);
    expect(v?.failure).toBeUndefined();
  });

  it('names the signal behind a signal exit code', () => {
    const v = classifyPostReadyExit({ kind: 'exited', exitCode: 137, oomKilled: false });
    expect(v?.failure?.message).toContain('SIGKILL');
  });

  it('distinguishes an OOM kill from an ordinary crash', () => {
    // Both surface as 137. The kernel SIGKILLs the process, so it writes nothing on the
    // way out and the log classifier has nothing to match — State.OOMKilled is the only
    // evidence that survives, and the remedy it points to is completely different.
    const v = classifyPostReadyExit({ kind: 'exited', exitCode: 137, oomKilled: true });
    expect(v?.failure?.code).toBe(FailureCode.OUT_OF_MEMORY);
    expect(v?.failure?.remedy).toMatch(/memory|MEMORY/);
  });

  it('attributes a vanished container to removal rather than to the application', () => {
    const v = classifyPostReadyExit({ kind: 'removed' });
    expect(v?.state).toBe(ExecutionState.FAILED);
    expect(v?.failure?.message).toMatch(/disappeared/i);
    // Lower confidence: we know it is gone, not that the application had anything to
    // do with it.
    expect(v?.failure?.confidence).toBe('medium');
  });
});
