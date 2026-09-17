import { describe, it, expect } from 'vitest';
import { ExecutionState, FailureCode, Sentinel, WrapperExit } from '@devlaunch/shared';
import { classifyExit } from '../services/execution/ExecutionManager.js';

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
