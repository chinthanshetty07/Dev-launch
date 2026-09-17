# Changelog

## 2026-09-17 — Independent verification, and nine defects it found

Branch `main`, working tree on top of `46ca3c1`. Not deployed; local tool.

Verification run under the kick-ass pipeline: requirements written and approved before
any change, then three independent proofs — an adversarial verifier subagent with fresh
context, a cold review of the diff, and mutation testing of the suite itself.

The author of this code was also its only reviewer up to this point. Seven of the nine
defects below were invisible to a green test suite.

### 1. A prompt-injected plan could execute arbitrary code, bypassing the command allowlist

The allowlist constrains *what command runs*. It said nothing about how a runtime
bootstraps, and several environment variables inject code before the program's first
line. `validateEnvVarKey` blocked only malformed identifiers and the reserved `DL_`
prefix; `NODE_OPTIONS`, `LD_PRELOAD`, `PYTHONSTARTUP` and even `PATH` passed cleanly.
`environmentVariables` is in `REPAIRABLE_FIELDS`, so a model — or a README instructing
one — controlled that channel end to end.

The project's own prompt-injection fixture tested only the `startCommand` channel, which
is why every test stayed green.

Added a denylist of code-injecting variable names and prefixes, checked case-insensitively.

- **Impact:** a plan whose `startCommand` validates cleanly can no longer smuggle
  execution through configuration.
- **Verified:** before the fix, a plan carrying `NODE_OPTIONS=--require=/workspace/evil.js`
  returned `ACCEPTED (exploit reachable)` from `RunPlanValidator.check()`. The verifier
  independently reproduced execution against the real runner image with the full
  hardening profile applied, printing `INJECTED-CODE-EXECUTED-VIA-NODE_OPTIONS` before
  the legitimate command ran. After the fix the same plan is rejected, and 15 vectors are
  covered by tests proven able to fail.
- **Known limitation:** a denylist, not an allowlist — applications legitimately need
  arbitrary configuration, so a novel vector in a future runtime would not be caught.
  `GCONV_PATH`, `LOCPATH`, `NLSPATH` and `RESOLV_HOST_CONF` were added during cold review
  of the fix itself, which is evidence the first list was incomplete.

### 2. A test run destroyed a running server's containers

`sweepOrphans()` matched on the `com.devlaunch.managed` label alone and removed every
match. Eight integration files call it in `afterAll`. Nothing distinguished "orphaned by
a crashed process" from "owned by a different, healthy, currently-running instance", so a
developer running `pnpm start` in one terminal and `pnpm test` in another had live
containers destroyed underneath them.

Containers now carry an instance id. `sweepOrphans` is scoped to the current process; the
unscoped `sweepAllOrphans` runs only at startup, when no run of ours can be in flight.

- **Impact:** concurrent DevLaunch processes no longer interfere.
- **Verified:** the verifier launched a session via the HTTP API while a suite ran; it
  reached `READY` with `http://localhost:33662/`, and `curl` to that URL returned
  `Connection refused` seconds later — the container had been swept by the other process,
  while the session still reported `READY`. This also explains intermittent suite
  failures during verification: two full runs were executing concurrently and sweeping
  each other. After the fix, three consecutive full runs were identical.
- **Known limitation:** a session that is already `READY` when its container disappears
  still reports `READY` — nothing re-checks liveness after readiness is reached. Recorded
  below as not done.

### 3. The capability test proved something other than what it claimed

`docs/security.md` claimed `capDrop ALL` was verified by `CapEff` being zero in
`/proc/self/status`. It is zero — but for **any** non-root process, with or without
`--cap-drop`. Measured in the runner image: `CapEff` is `0000000000000000` either way, so
the assertion proved only that the container is non-root, which another test already
covered.

`CapBnd`, the bounding set, is what `--cap-drop ALL` actually zeroes
(`00000000a80425fb` without it) and is the ceiling on what a process could acquire
through a setuid binary.

- **Verified:** deleting `CapDrop` from the container config left the capability test
  green. After switching to `CapBnd`, the same deletion turns it red.
- **Impact:** documentation and test now describe the same thing, and that thing is real.

### 4. An un-inspectable container was reported as a failed application

`isRunning()` swallowed every Docker API error and returned `false`, turning "I could not
determine the state" into "it exited" — after which the caller built a diagnosis from an
exit code belonging to a container that was very likely still running. Under load a
transient API error is ordinary.

Now three outcomes: running, exited, or unknown. Inspect retries (it is an idempotent
read), a `404` is treated as definitive removal rather than uncertainty, and an
unattributable failure says so and carries the underlying error.

- **Verified:** with the honest reporting in place, a real run surfaced
  `(HTTP code 404) no such container` where the previous code had silently reported
  `START_COMMAND_FAILED`. Six regression tests, proven able to fail by restoring the old
  behaviour.

### 5. Three security controls were documented as kernel-verified but only config-checked

`docs/security.md` claimed every control is verified by reading kernel state. Its own
table admitted three rows were "container config": `no-new-privileges`, the `noexec`
`/tmp` mount, and the CPU quota. The `/tmp` mount had no test at any level.

The probe now reads `NoNewPrivs` from `/proc/self/status`, reads `/proc/mounts`, **stages
an executable in `/tmp` and confirms it is refused**, and reads the cgroup `cpu.max`
quota.

- **Verified:** integration security tests went from 14 to 17; the doc's claim is now
  true for every row. The controls themselves were already working — this was a
  verification-methodology defect, not a hole.

### 6. Documentation counts were wrong in four more places

`README.md` claimed 67 security tests (54 unit, 13 integration); actual at the time was
116 (102 + 14). `docs/architecture.md` described Phase 8 as absent although `GroqProvider`
is wired live, and its state diagram omitted `REPAIRING`, a state entered on every repair.
`docs/fixtures.md` listed 16 of 17 fixtures — the missing one being
`unrecognized-app`, which carries the prompt-injection probe central to the Phase 8
security story.

- **Verified:** counts re-derived mechanically from the source, not from memory.

### 7. Two tests asserted nothing

`failureClassifier.test.ts`'s "gives every signature a remedy" iterates `SIGNATURES`; with
an empty table the body never runs and the test stays green. `sessionManager.test.ts`'s
"keeps an active session even when finished ones pile up" never created any finished
sessions, so the interaction in its name was untested.

Both now guard the precondition and create the pressure they claim to test.

### 8. Cleanup failures were collected and silently discarded

`CleanupManager.cleanup()` resolves successfully with per-container errors in its return
value. Both call sites ignored that value, and their surrounding `catch` blocks were dead
code for the realistic failure. A container that failed to stop left no trace until the
next process start. Errors now reach the session log.

### 9. Tests leaked scratch directories, and the HTTP API had no tests at all

Four `mkdtemp()` call sites had no matching removal; 92 directories had accumulated from
one day's activity. All now clean up.

No test imported `api/app.ts` — `POST /api/sessions`, `/resolve`, `/cancel`, the 409
conflict path and the fixture allowlist were only ever exercised by hand. Added 13 tests
against a real Express server with a stubbed executor.

### Testing

- Suite grew from 338 to 379 tests (376 passing, 3 skipped).
- **Baseline before this work:** 336 passed, 1 failed, 1 skipped — the suite was not
  green, and the failure was load-dependent rather than deterministic.
- **After:** three consecutive full runs produced identical results (376 passed,
  3 skipped) with zero residual containers, clone directories, or scratch directories.
- Critical tests were proven able to fail by mutation: removing `CapDrop`, allowing
  `curl` in the binary allowlist, removing session eviction, restoring the old
  error-swallowing state check, and stripping the new environment denylist each turned
  the relevant tests red, and green again on restore.
- Live Groq tests are now opt-in via `DEVLAUNCH_LIVE_AI=1`. They call a rate-limited
  external service and therefore cannot be deterministic; leaving them in the default
  suite meant a green run and a red run proved the same thing. Run deliberately during
  verification: 3 passed.
- **Not verified:** a from-scratch setup (wiping `node_modules`, rebuilding both runner
  images, following `setup.md` on a clean machine) was excluded at the requirements gate,
  because it destroys the user's Colima state. The documented commands were checked by
  inspection only.
- **Not verified:** an exhaustive tautology sweep. The verifier read 8 of 24 test files
  closely for tests-that-cannot-fail; the remainder were read partially or not at all, so
  more instances of defect 7 may exist.

### Known open items, deliberately not addressed

- **A `READY` session does not re-check liveness.** If its container disappears after
  readiness, the session reports `READY` against a dead URL indefinitely. Found by the
  verifier; scoping the orphan sweep removes the common cause but not the class. Needs a
  periodic health re-check, which is a behavioural change beyond a verification pass.
- **`RepositoryMetadata.fileCount`/`sizeBytes` measure the repository root even when
  analysing a subdirectory.** Cosmetic; no consumer depends on it.
- **The denylist in defect 1 is not exhaustive by construction.** An allowlist is not
  possible for application configuration.
