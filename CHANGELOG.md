# Changelog

## 2026-09-17 — The pipeline strip threw away the one thing it knew

Follows `ccaf5e1`. Frontend and shared only; no change to how a session runs.

### The progress row went blank exactly when it mattered

`statusFor` in `PipelineStrip.tsx` carried this comment:

> A failed or cancelled session stops advancing, so the furthest stage it reached is
> inferred from the states already passed rather than from the terminal state itself.

It did not do that. `if (terminalFailure) return 'pending'` ran before the inference it
describes, so `effective` was dead and **every** stage greyed out the moment a session
failed. A run that died during startup looked identical to one that never began, at the
one moment you most want to know where it stopped. `STYLES.failed` and `MARK.failed`
(`×`) were defined and unreachable — nothing returned `'failed'`.

`REPAIRING` and `CLEANING_UP` hit the same path from the other side: neither is in the
`ORDER` array, so `indexOf` returned `-1` and the strip blanked mid-repair too.

The underlying problem is that the current state cannot answer "how far did this get".
`FAILED` is not a point on the pipeline, and `REPAIRING` sends a session *backwards* to
`VALIDATING`. So the client now keeps a high-water mark of the furthest state it has
seen, and the projection reads from that.

- Stages before the stopping point stay `done`; the stage it stopped in is `×` red.
- A session that died *after* readiness fails at the Ready chip and nowhere earlier —
  every stage genuinely succeeded. Marking an earlier one would point at a step that
  worked, which is the same error as reporting `APPLICATION_EXITED` as
  `START_COMMAND_FAILED`.
- `REPAIRING` keeps the progress already earned and says `repairing` in the header,
  rather than implying the pipeline restarted itself.
- A page opened *after* a session finished has no transition history, so the furthest
  point is inferred from the snapshot instead: `readyAt`, then `failure.phase`, then the
  presence of a plan. Each can only have been set by getting at least that far.

The projection moved to `packages/shared/src/pipeline.ts`. What a state means to a person
is part of the contract — `FailureDetail` already carries user-facing `remedy` prose — and
it is the difference between one testable decision and one per client.

- **Verified in the browser** against the running backend: `node-module-missing` shows
  `ok` through Start and `×` at Readiness; `node-dies-after-ready` shows all six stages
  `ok` and `×` on Ready alone; a repair in flight keeps its green stages and shows the
  `repairing` badge.
- **Proven able to fail:** restoring the original grey-out turns 5 tests red; reading
  progress from the current state alone turns 8 red; letting the Ready chip ignore a
  post-ready death turns 1 red.
- 20 tests added (suite 399 → 419). They live in the backend suite because that is where
  a working vitest is; `packages/shared` still has no runner of its own, and adding one
  to the frontend was abandoned after pnpm resolved `vitest` to a dangling symlink.

## 2026-09-17 — Liveness after readiness, and two defects found closing it

Follows `828d0fb`. Closes the item that verification left open, and two more that closing
it exposed. Not deployed; local tool.

### 1. A `READY` session never checked whether its application was still running

Readiness was a measurement taken once and then trusted indefinitely. An application that
answered a request and crashed a minute later left the session reporting `READY`, and
offering a URL that answered nothing, until the idle clock expired half an hour on.

A `READY` session now re-checks its container every five seconds
(`DEVLAUNCH_TIMEOUT_LIVENESS_MS`) and ends when it is gone: `APPLICATION_EXITED` for a
crash, `COMPLETED` for a clean exit, `OUT_OF_MEMORY` when the kernel killed it. The URL is
cleared, and the container released rather than merely relabelled.

Three rules govern the check:

- **Only a definite answer ends the session.** `unknown` — an inspect that failed after
  three retries — leaves the session `READY` and logs once. The opposite choice would
  turn every busy-daemon hiccup into a fabricated report that the user's app had died,
  which is a worse failure than the one being caught. This is the same conflation that
  made exit-code attribution wrong in defect 4 of the previous entry.
- **A clean exit is completion, not failure.** A server that returns 0 shut itself down.
- **An OOM kill is told apart from an ordinary crash.** Both surface as exit `137`, and
  the kernel's `SIGKILL` leaves no log line for the signature classifier to match, so
  `State.OOMKilled` is the only evidence that survives.

`APPLICATION_EXITED` is new, and is the only code describing something going wrong after
success. `START_COMMAND_FAILED` would be actively misleading: the command was right, it
ran, and it served traffic.

- **Verified:** a new fixture, `node-dies-after-ready`, serves a real HTTP 200 and then
  exits 3. The session reaches `READY`, is fetched successfully, and flips to `FAILED` /
  `APPLICATION_EXITED` with `exitCode: 3` about three seconds later, quoting the app's
  last log line as evidence. A second test kills a healthy container with `SIGKILL` from
  outside and gets `APPLICATION_EXITED` naming the signal.
- **Proven able to fail:** with the watch removed, the same test reports
  `Timed out waiting for FAILED/COMPLETED; session is READY` after 60 seconds — which is
  precisely the defect. Three further mutations (treating `unknown` as death, keeping the
  dead URL, skipping the budget release) each turned a test red and green again on
  restore.
- **A defect in this fix, caught by mutation testing.** `touch()` re-arms the lifetime on
  every `GET /api/sessions/:id`, and each re-arm starts a watch; a watch whose probe was
  in flight survived the timer sweep and re-scheduled itself into the new list, so an
  actively-polled session accumulated watchers. A generation token now supersedes the old
  watch. The first version of the test for this passed with the guard removed, because a
  fake probe that resolves in a microtask never creates the window the bug needs —
  measured with a 15 ms probe, a polled session ran 40 probes per 200 ms against a
  correct 10.

### 2. Every session was killed at ten minutes, whatever the lifetime clock said

Found immediately by the watch in defect 1, which reported healthy applications dying for
no visible reason.

`docs/architecture.md` documented two clocks, "deliberately": a ~10 minute time-to-ready
budget, and a session lifetime of 30 minutes idle / 60 minutes hard cap starting at
`READY`. The code did not implement that. `waitForExit` enforces the budget by **stopping
the container** when it elapses, and nothing released it on `READY` — so the container was
stopped ten minutes after launch regardless, with nothing in the logs to explain it. The
document asserted the exact property the code violated.

The budget is now liftable via an `AbortSignal`, and a session releases it on `READY`.

- **Verified:** a container launched with a 2-second budget, made ready, then left for 6
  seconds, is still running and still serving HTTP 200. Reverting the fix turns that test
  red with `expected false to be true`.
- **Also verified: the budget still bites.** A container that never becomes ready is
  still stopped when its budget elapses — lifting it on `READY` must not disarm it for an
  application that never gets there.
- A derived `.catch()` now absorbs the exit promise's rejection. Nothing awaits it on the
  session path, and lifting the budget makes "container removed while the wait is in
  flight" a reachable state rather than a theoretical one.

### 3. Repair replaced an accurate diagnosis with a guess about its own guess

Found while establishing determinism: one full run in three failed with
`expected 'START_COMMAND_FAILED' to be 'PORT_BOUND_TO_LOCALHOST'`.

`node-bind-localhost` hardcodes `127.0.0.1`, which no plan change can fix — but
`PORT_BOUND_TO_LOCALHOST` is repairable in general (Vite, Flask and Django all bind
loopback *by default*, where `--host 0.0.0.0` genuinely fixes it), so the session spent
two live model calls on it. When repair was exhausted the session reported the **last**
attempt's failure, which describes a plan the model invented rather than the repository
the user wrote. Measured directly against the real pipeline, three runs of the same input
ended on three different plans: `npm run start -- --host 0.0.0.0`, `npm run start`, and
`node server.js`.

So the cause a user was shown depended on model output, and an application that plainly
binds loopback could be reported as failing to start. The first diagnosis is now kept, and
what the attempts produced is logged rather than presented as the cause.

- **Verified:** the real pipeline now reports `PORT_BOUND_TO_LOCALHOST` regardless of
  which plans repair tries. Reverting to last-failure-wins reproduces the original suite
  failure exactly.
- **A consequence of this fix, found by review.** Retaining the first failure meant a
  session that repair *did* fix arrived at `READY` still carrying the diagnosis of the
  attempt that failed — an error shown against a working application. Cleared at `READY`;
  reverting that turns its test red.
- **Not addressed:** `tryRepair`'s comment claims each attempt "must differ from the
  last", and nothing enforces it — one probe run had the model return the identical
  command and it was accepted, spending a container launch to learn nothing. Enforcing it
  changes how many model calls a repair costs, which is a product decision rather than a
  bug fix.

### A second suite taken off the live model

The same streaming suite failed a different way on another run: the listener timed out
after 90 seconds, and the next test then failed on the concurrency limit because the
session was still going. The cause is the same test provoking a repairable failure with a
key configured — two live model calls, whose latency belongs to a rate-limited external
service.

The previous entry made the Groq tests opt-in for exactly this reason. This suite was
paying the same cost without being about AI at all, so `startServer` now takes
`{ ai: false }` and the streaming tests use it. The default is unchanged.

- **Verified:** three consecutive runs of that suite, 7 passed each.

### One test made honest about a race it was losing

`dockerRunner`'s "serves real traffic" test fetched a published host port immediately
after the application logged that it was listening. Under Colima the host side of a
published port lives in the Lima VM's forwarder, wired up asynchronously after the
container starts, so the connection can be refused while everything works correctly. It
passed 5/5 alone and failed roughly 1 in 3 under full-suite load.

The fetch now retries **only** `ECONNREFUSED`, for at most 10 seconds. Every assertion is
unchanged, and pointing the same test at a genuinely unreachable application still fails
it. Production code never meets this race because the readiness checker polls.

### Testing

- Suite grew from 379 to 399 tests (396 passing, 3 skipped).
- **Four** consecutive full runs are identical.
- **Residue, measured properly this time.** The check used while making those runs was
  wrong twice over: it filtered containers on `devlaunch.managed` when the label is
  `com.devlaunch.managed`, and looked for scratch directories in `/tmp` when
  `os.tmpdir()` on macOS is `/var/folders/…/T`. Both matched nothing and so proved
  nothing. Re-measured as a before/after delta across a full run: **0 new containers, 0
  new scratch directories**, which is the claim the previous entry's cleanup fixes were
  making. The same broken paths are why that entry could report the fixes verified — 109
  directories from before them are still sitting in the real tmpdir, untouched by any
  run since. They are stale rather than leaking; removing them is a `rm -rf` in the
  user's temp directory and is left to the user.
- Nine mutations were used to prove the new tests can fail; each is named above. One of
  them initially did *not* fail, which is how the generation-guard test was found to be
  testing nothing.
- **End to end, by hand:** `https://github.com/heroku/node-js-getting-started` cloned,
  detected as `express` by the rule-based planner, `READY` in 9.1 s serving HTTP 200 and
  9,109 bytes. Killing its container from outside moved the session to `FAILED` /
  `APPLICATION_EXITED` — "terminated by SIGKILL after it had become ready" — 5.1 seconds
  later, with the URL cleared. The 5-second poll interval accounts for the delay.
- **Live AI suite (opt-in, `DEVLAUNCH_LIVE_AI=1`): 1 passed, 2 failed on quota, not on
  code.** Groq's free tier has a *daily* token budget, and a day of repair probing
  exhausted it: `tokens per day (TPD): Limit 200000, Used 198916`. Planning prompts are
  small enough to still get through; repair prompts carry logs and metadata and do not.
  The product behaves correctly under it — the repair reports
  `429 (rate limited, and retries were exhausted)`, the session falls back to the original
  diagnosis, and no container leaks. Re-runnable tomorrow.
- **Not addressed, still open:** the liveness check asks whether the process exists, not
  whether it still serves traffic. An application that wedges without exiting, or starts
  returning 500s, stays `READY`. Recorded in `docs/limitations.md`.

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
  below as not done, and closed by the entry above this one.

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

> Corrected by the entry above: "all now clean up" was verified by counting `/tmp`, which
> is not where `os.tmpdir()` points on macOS, so the check could not have observed either
> the leak or the fix. Re-measured as a delta across a full run, the fixes do hold — 0 new
> directories. The 109 that pre-date them were never removed and are still there.

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
  **Closed** by defect 1 of the entry above.
- **`RepositoryMetadata.fileCount`/`sizeBytes` measure the repository root even when
  analysing a subdirectory.** Cosmetic; no consumer depends on it.
- **The denylist in defect 1 is not exhaustive by construction.** An allowlist is not
  possible for application configuration.
