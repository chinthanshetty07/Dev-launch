# Changelog

## 2026-10-01 — Keep a session's installed packages between its containers

Every container started from an empty workspace, so every restart installed everything
again. A repair that changed only a port reinstalled the whole tree, and the second service
of a shared workspace installed what the first had just installed. Measured on
`ejazahm3d/fullstack-turborepo-starter`: three installs of one tree took 197 of its 222
seconds.

- `/workspace` is now a named volume per session (and per service, or shared between
  services that install one workspace), removed when the session ends and swept at
  startup like containers.
- A launch skips its install only when the same install (image, command and directory)
  already *finished* in that volume. A failed install, or one cut off midway, gets a fresh
  volume. The wrapper says so in the log, and DevLaunch sets the flag, never a plan.
- Measured live: ejazahm3d went from 222 to 87 seconds, with `web` reusing `api`'s
  install. remix/indie-stack went from 254 to 174 seconds: its port repair took 4 seconds
  instead of a reinstall.

Tested against real Docker (`integration/workspaceReuse.test.ts`): reuse after a finished
install, a fresh install when the command changes, never after a failed or cut-off
install, and volumes removed at the end. Unit tests cover the keys, teardown and sweeps.
Ten mutations, all caught by a named test.

## 2026-10-01 — Read a NestJS application's port from src/main.ts

The list of entry files the port detector reads had `main.js` but not `main.ts`, where
every NestJS application starts. ejazahm3d's api writes `const PORT = 5002`; it was
planned on 3000, failed, and was corrected by a repair, which meant a full reinstall. It is
now planned on 5002 the first time. `app.mjs` and `main.mjs` were added beside it.

## 2026-10-01 — Stop waiting for a database container that has already exited

A compose file's `postgres:15.1-alpine` exits under the sandbox within two seconds, but its
health check was retried against the dead container for the full 90-second budget before
DevLaunch's own `postgres:16`, ready in 1.6 seconds, was tried. Measured on
`testdrivenio/fastapi-crud-sync`: 92 of its 107 seconds. The wait now ends as soon as the
container has stopped, and the run takes 12 seconds. A database that is still starting is
running, and keeps its full budget.

## 2026-10-01 — Write the generated requirements file for whichever step uses it

In after4, `nsidnev/fastapi-realworld-example-app`'s rule plan was rewritten by the model:
install `asyncpg==0.29.0` first, a version that has a Python 3.12 wheel, then
`pip install -r /workspace/.devlaunch/requirements.txt` as the build step. That was a
reasonable plan. It died at once on `Could not open requirements file`, because DevLaunch
wrote that file only when the **install** command named it.

The file is now written when the install, build or start command names it. Nothing a plan
controls changed: the content still comes only from the repository's own pyproject.toml,
rebuilt and checked line by line (`docs/security.md`). A plan that never names the path
still gets no file.

Tested by four unit tests (each step, and a plan that never names it) and by a real-Docker
test that runs the after4 plan shape against `python-poetry-ranges` to READY. Five
mutations, all caught by a named test, one of them against the real-Docker test. Not
re-run live on nsidnev: a dashboard session was running, and restarting the backend would
have ended it. Underneath, nsidnev's own problem is unchanged: its declared
`asyncpg ^0.26` has no Python 3.12 wheel.

## 2026-10-01 — A static site no longer logs a favicon 404

Every browser asks for `/favicon.ico` on its own. A repository of plain HTML without one
showed `favicon.ico: 404 (File not found)` in the console of a page that was working, for
a request the page never made. Seen live on `chinthanshetty07/Customer-Churn-Prediction`.

A static site is served by a server DevLaunch chose, so the answer is DevLaunch's to give.
The static plan now starts `python /workspace/.devlaunch/serve.py 8000`, which is Python's
`http.server` with one difference: a missing `/favicon.ico` gets `204 No Content`.

- A `favicon.ico` the repository has is served unchanged, and every other missing file is
  still an honest 404.
- No icon is invented. The request log and the bind to every interface are the same as
  `http.server`'s.
- The script is copied in beside the wrapper, after the repository, and only when the plan
  starts it — the same route as the generated requirements file. `python <path>` already
  passes the command validator, so no allowlist changed.
- Applications are untouched: Flask's or Express's 404 is the application's own answer, the
  same one it gives on the developer's machine (see `docs/limitations.md`).

Tested in the runner image and in real Docker against two fixtures: `static-site` (no icon:
204) and the new `static-site-favicon` (its own icon: 200, same bytes). Six mutations, all
caught by a named test.

## 2026-10-01 — The memory ledger asks Docker before it counts a container

A dashboard run of `wrrnlim/nextjs-docker-postgres-template` was refused memory: "the VM
has no more to give: 86 MB is free after the 8 other container(s) this run holds (1024 MB,
…)". Docker had no DevLaunch container in it at all.

The ledger trusted every removal path to release a container's hold, and at least one did
not. A container that no longer exists cannot be sampled, and an unreadable sample counts at
the full limit, so each leaked hold cost 1024 MB for the life of the process. After a
session of dashboard stops there were eight of them.

- `usageMb` now tells *gone* (Docker answers 404) apart from *unreadable*. The ledger
  releases a gone container's hold; an unreadable one still counts at its limit, so nothing
  is undercounted.
- One leaking path was reproduced: the shutdown label sweep removing a database that was
  still being created. The path the dashboard took was not identified. Tearing down again on
  a caught stop was tried and taken out, because it made no difference any test could see.
  The check against Docker covers both paths, and any later one.

Tested by a unit test and by a real-Docker test that removes a running container behind the
ledger's back (`integration/memoryLedger.test.ts`). Two mutations, both caught by a named
test. The `after4` corpus ran on a backend with this fix and an empty ledger.

## 2026-09-30 — Plan a Flask application factory by rule

`JayBhatt2021/improved-flask-tutorial-app` keeps its application where the official Flask
tutorial does: `create_app()` in `flaskr/__init__.py`, with no `app.py` anywhere. No rule
saw it, so every corpus run handed it to a model, which planned it three different ways —
gunicorn, waitress, and in after3 `python -m gunicorn` without installing gunicorn
(`gunicorn: not found`). A pass that depended on which plan the model chose.

- The package scan reads a package's `__init__.py` when it has no conventional entry
  file, and counts it only when it makes the application: a module-level
  `app = Flask(...)`, or a `create_app`/`make_app` Flask can call with no arguments.
  A Blueprint package, or a factory that needs an argument, is not an entry point.
- The plan names the factory — `FLASK_APP=flaskr:create_app` — unless a module-level app
  exists, which Flask takes first.
- `app = Flask(...)` indented inside a factory is a local; it was reported as the
  module's app object, which would have made the plan rely on Flask's discovery instead.

Verified live: the repository is planned by rule, installs with `pip install .`, and
answers 200 on `/` in 14 s with no model call and no repair (`reports/flask-factory.md`).
New fixture `python-flask-factory`, served in real Docker by the pipeline suite; nine unit
tests; eight mutations, all killed by a named test.

## 2026-09-29 — Installs are detected in one place, and out-of-memory is climbed, not guessed

`horusyeung/nextjs-nestjs-fullstack-starter` failed `OUT_OF_MEMORY during install`, and the
recovery had four defects, each found in the live run rather than by reading:

- the shared-install gate released the second service after the first was **killed**, so
  it ran the same tree at the same limit and died identically;
- the gate asked about memory only when a container had exited, but a killed yarn leaves
  the wrapper alive long enough to print its install-failed marker — so the case that
  actually happens was never asked about (a fake that died without the marker had passed);
- a memory raise was one jump to the ceiling, counted against the two plan repairs;
- the single-service OOM retry skipped releasing the dead container, which stayed until the
  backend restarted.

**Now READY, both services** — its best before was partly running. Measured twice. Under
the old half-VM ceiling api's shared install climbed 1024 → 2048 → 2955 MB in place, each
step detected by Docker's own `OOMKilled`, and fitted that run (it does not always: see the
ceiling below); web waited, then started at the limit the shared install needed; both
answered 200, and stopping left no container. Under the new ceiling api climbed
1024 → 2048 → 4096 and installed, web started at 3625 MB — the 4096 it needed, capped by
the memory measured free at that moment — and both reached READY again.

### Install detection — `analysis/InstallDetection.ts`

One module decides every install; the planner and workspace installs (which had its own
lockfile table and never read `packageManager`) both ask it. It returns
`{ packageManager, declaredManager, lockfile, ignoredLockfiles, installCommand,
relaxedCommand, projectType, confidence, notes }`.

- With a lockfile the install is **strict** — `npm ci`, `pnpm install --frozen-lockfile`,
  `yarn install --frozen-lockfile` (Yarn 1) or `--immutable` (Yarn 2+, from the lockfile's
  own format or `packageManager`). A new deterministic repair falls back to the relaxed form
  **only** on the manager's "lockfile out of date" refusal — captured from the runner image
  for npm, pnpm and Yarn 1 — and never on any other install failure.
- **Bun** (`bun.lock`, `bun.lockb`, `bun@`) is recognised and reported, and installed with
  npm: DevLaunch ships no Bun, by the user's earlier decision.
- **Python**: requirements.txt, pyproject (buildable or not), Pipfile and poetry.lock are
  recognised; lockfiles pip does not read are reported as `ignoredLockfiles`, not claimed.
- *Rewritten tests:* the planner's package-manager test asserted the relaxed commands with a
  lockfile; it now asserts the strict ones and says why.
- *Measured, not assumed:* strictness is not what made horusyeung's install large. Peak
  memory with headroom was 2635 and 2433 MiB with `--immutable`, 2699 and 2703 without.

### The memory policy — `execution/MemoryPolicy.ts`

`memoryPolicy()` is the one place for the initial limit (`DEVLAUNCH_CONTAINER_MEMORY_MB`,
1024), the ceiling (the VM less its reserve, ≤ 4096 — see below), the step (doubling, or
`DEVLAUNCH_MEMORY_STEP_MB`), the raise limit (`DEVLAUNCH_MEMORY_RETRY_LIMIT`, 2) and
`DEVLAUNCH_MEMORY_RETRY_ENABLED`, validated, read at call time (the `.env` trap). On this VM
the ladder is **1024 → 2048 → 4096**. `MemoryBudget` holds every container's limit,
databases included, against the VM less `DEVLAUNCH_MEMORY_RESERVE_MB` (512), and an
escalation takes at most what is free — counting other containers at what they **use**,
sampled from Docker and capped by their limit. Counted at their limits, an api idling at a
few hundred MB after a 2955 MB install refused web memory the VM plainly had.

Memory raises have their **own** budget, apart from the two plan repairs, so a ladder cannot
leave a run without the plan fix it needs once it has memory enough. Bounded twice: by the
raise count, and by limits that only increase toward the ceiling.

**The ceiling is what the VM has free, not half of it** — the user's decision, from the
measurements. horusyeung's install peaks at 2.4–2.9 GB with headroom (2635, 2433, 2699,
2703 MiB over four runs), right at the old ceiling of half this VM (2955 MB), so it fitted
some runs and not others. `containerMemoryCeilingMb` is now the VM less
`DEVLAUNCH_MEMORY_RESERVE_MB`, capped at 4096; what the run's other containers need is no
longer assumed to be the other half, because the ledger counts them as they are. A 2 GB VM
now gets 1536 at most — never the whole machine. The ceiling tests were rewritten to say so,
not flipped.

### Out-of-memory detection — `failures/OomDetection.ts`

Measured first: a child OOM-killed inside the container sets `OOMKilled` while the wrapper
exits **110**; a Node heap failure leaves it false. So Docker's flag decides; a `Killed`
line or exit 137 stands in only when the flag cannot be read, and is **overruled** when
Docker says false. A Node heap OOM is its own kind, answered first with
`NODE_OPTIONS=--max-old-space-size` at three quarters of the container — set by DevLaunch in
the wrapper's control variables; plans still cannot set `NODE_OPTIONS` — and only then with
a larger container. Failures carry `memory: { kind, limitMb, detectedBy, maximumMb,
attempts, retryable }`; the dead-container path no longer assumes every OOM was the install.

### Retries, records, cleanup

- **Retried:** a container OOM, up the ladder; a heap OOM, heap first. **Not retried with
  memory:** anything else — install errors, a lockfile refusal (which relaxes instead), a
  build failure, a port that never opens.
- The final failure says what was tried: *"Dependency installation exceeded the container
  memory limit. DevLaunch retried with progressively larger memory limits (1024 → 2048 →
  4096 MB) but it still exceeded the maximum available memory (4096 MB, the 4096 MB
  DevLaunch gives any one container)."* — or that there was nothing larger to try, or which containers hold
  the rest. Never that the repository is broken.
- Every launch is a `LaunchAttempt` (service, attempt, memory, heap, install command,
  result, phase, `detectedBy`, duration) kept across retries and on the wire with a
  per-service `install` summary; the log says `[install] api · Attempt 2/3 · memory limit
  2048 MB · running: yarn install --immutable`, then `OOM detected (docker: OOMKilled)` and
  `Increasing memory: 1024 MB → 2048 MB`. The dashboard's failure panel shows the memory
  line.
- Each retry releases the failed container before its replacement exists; the ledger
  releases with it.

### What is one limit per container

A container runs install, build and start, so it has one limit; the phase that ran out is
recorded, and a service raised for its install keeps that limit while it serves. A limit per
phase would mean resizing a live container between phases, which is not done.

- **Fixtures:** `node-install-oom` — a real 1.4 GB install, killed at 1024 MB and served at
  2048 MB against real Docker, with no container left and nothing held afterwards.
- **Tests:** the spec's fourteen scenarios, the shared-install gate with the measured
  wrapper sequence, the Docker-flag rules, the policy and the ledger. **Mutations:** 35,
  all killed by the test that names them. Two survived first and gained the tests that
  kill them — memory escalation gated behind the plan-repair limit, and the workspace
  manager field — and one kill was discarded because the mutant called a function that
  did not exist, which proves nothing about the behaviour.

## 2026-09-29 — A Poetry project is installed within the ranges it declares

A pyproject project that is not a buildable package — several top-level directories, no
package configuration — had its dependencies installed by name, because a version range
cannot be written on a command line the allowlist permits: no `<`, `>` or quotes. By name,
`nsidnev/fastapi-realworld-example-app`'s `pydantic = "^1.9"` became pydantic 2 and the
report named `BaseSettings has moved` rather than anything about the project.

The user chose between three answers: widen the allowlist, leave it, or generate a
requirements file. It is the file. `pyprojectRequirements` rebuilds the runtime
dependencies — `[project] dependencies`, or `[tool.poetry.dependencies]` with Poetry's `^`
and `~` translated by Poetry's own definitions — as PEP 508 lines, and the plan installs
`pip install -r /workspace/.devlaunch/requirements.txt`. The deterministic repair for a
flat layout `pip install .` refused now installs the same way.

- **Ranges, not the lock.** `poetry.lock` was resolved for the author's Python; DevLaunch
  has one, 3.12, and the declared ranges leave room for a release with a wheel for it.
- **No text from the repository reaches the file unexamined.** A requirements file obeys
  `--index-url`, `-e` and `-r`. Every line is rebuilt and held to `SAFE_REQUIREMENT`;
  anything else — a URL, a marker, `||` — becomes the bare name it had before.
- **From the repository, never from a plan.** The executor derives the content when it
  creates the container, from the pyproject in the plan's working directory, with the
  read held inside the source directory. A plan naming the path gets the repository's file.
- **nsidnev will still fail**, now for its real reason: `asyncpg ^0.26` stays below 0.27,
  which has no Python 3.12 wheel. That is the contract, reported as such.
- **Rewritten tests, intents kept:** three planner tests and one repair test asserted the
  install-by-name command. Each now asserts the file command and says what changed; what
  the file holds — the declared set, dev groups excluded, no option ever — is tested on
  the converter.
- **Fixture:** `python-poetry-ranges`, `flask = "^2.3"` and code that refuses Flask 3.
  Before: `RuntimeError: this application needs Flask 2 … got Flask 3.1.3`. After: READY
  on Flask 2.
- **Mutations:** thirteen. Two guards no test could distinguish were deleted — a
  marker/URL branch and an explicit `||` check, both already refused by the line pattern
  — and a quote-naive tokenizer, which the first test did not pin, gained the test that
  does. The older name-only reader, `pyprojectDepsBySection`, still has that tokenizer.

## 2026-09-29 — A server DevLaunch planned that exits 0 has stopped, not finished

`ahfarmer/calculator`'s dev server closed on an empty stdin and the session said
`COMPLETED` — "the expected shape for a script" — about a plan DevLaunch had built to serve
port 3000. The `CI=true` fix keeps that server up; this fixes the report, for the next
server that stops itself for a reason nobody has met yet.

A single-service run that exits 0 before readiness is now a failure when the plan is a
server — `hostBinding: 'forced'`, a recognised framework told where to listen — and
`COMPLETED` otherwise, as before, for scripts, CLIs and entry files DevLaunch could not
bind. The failure is `APPLICATION_EXITED`, worded as the sibling path for a container
found dead before readiness already worded it ("the start command finished successfully
instead of serving"), with the last line the process printed and no repair: the command
was right and the reason is in the log. The two paths now share that sentence. A
project's services were already treated this way; single services now agree with them.

Decided by the user, from the options put to them after the corpus run.

- **Unchanged test, still true:** a `node server.js` plan exiting 0 is `COMPLETED`
  (`containerState.test.ts`); its plan binds nothing, so it is not a planned server.
- **Fixture:** `node-cra-stdin` without `CI=true`. Before: `COMPLETED`. After: `FAILED`,
  `APPLICATION_EXITED`.
- **Mutations:** a planned server still `COMPLETED` (unit and integration), and every exit
  0 a failure. All killed, the last by the unchanged CLI test.

## 2026-09-29 — The corpus runner no longer overwrites a report

The reproduction command given for the after-run, `run.mjs --name after`, wrote into the
committed report; run later while another session held the slot, it replaced two results
with harness errors and dropped the report's note. A full run into an existing name is
now refused without `--overwrite`, and a subset re-run keeps the note. The committed
report was restored.

## 2026-09-29 — A runtime too new is named, and not answered with a newer one

With `CI=true`, `ahfarmer/calculator`'s dev server stays up long enough to compile, and
webpack 4 fails under OpenSSL 3: `ERR_OSSL_EVP_UNSUPPORTED`. It was `START_COMMAND_FAILED`
at low confidence and went to a model, whose repair set `NODE_OPTIONS` and was refused. A
new signature makes it `WRONG_RUNTIME_VERSION` with a typed `runtimeDirection: 'older'`;
the deterministic repair declines on that, so there is no retry on Node 22 and no model
call, and the remedy names the upgrade (react-scripts 5 / webpack 5) or Node 16.
Signatures can now attach typed `detail` to their verdict.

- **Fixture:** `node-openssl-legacy`, webpack 4's `createHash('md4')` without webpack.
  Before: low-confidence `START_COMMAND_FAILED`. After: `WRONG_RUNTIME_VERSION`, high
  confidence, direction `older`.
- **Mutations:** signature removed, direction not attached, dropped by the classifier,
  ignored by the repair — all killed. A second pattern for the message text survived
  (Node prints the code with every one) and was removed. Moving the signature after the
  generic runtime one also survives: nothing else matches these lines, so its placement
  is for reading, not correctness.

### A correction: the mutation harness reported survivors as kills

Test files were passed to the mutation helper as one string, and zsh does not word-split
an unquoted parameter — so every mutation run against more than one test file handed
vitest a single path that matched nothing, exited non-zero, and was counted killed. The
entry for the bind-host variable blamed "a flaky Docker test" for one such result; there
was no flake. The helper now reports a run that found no tests, crashed, or failed without
a named test as a harness error, never as a kill, and it was checked against a known
survivor and a missing file before use.

Every mutation this session had run with several test files was re-run: argument
forwarding (1), the Angular builder (6), phase-scoped diagnosis (8), CRA (1). All are
genuinely killed, each by the test that names it. No earlier conclusion changes except
that one sentence.

## 2026-09-29 — A repository with submodules is told so before the run

The after-run left two repositories whose fixes had worked and uncovered something
underneath, both outside the contract, both reported in words that named a file
rather than the reason. This is the first; the runtime entry above is the second.

`angular-realworld` bundles `realworld/assets/theme/styles.css`; `realworld/` is a git
submodule, and intake clones with `--no-recurse-submodules` by design. The run ended
`PORT_NOT_LISTENING` quoting esbuild's advice to mark the path external. The analyzer now
reads the root `.gitmodules` into `submodules` and warns before the run, naming the
directories — once, on the single-service, workspace and project paths alike (the project
path reports its services' warnings rather than the repository's, so it carries this one
across itself). Only for the repository: a subdirectory analysed alone says nothing.

- **Fixture:** `node-submodule`. Before: no warning. After: the warning, naming `realworld/`.
- **Mutations:** six — no warning, a warning for subdirectories, only the first path,
  the singular grammar, the project path silent, the paths not recorded. All killed.

## 2026-09-29 — The corpus after these fixes: 30 of 40

`reports/after.md`, measured against `c68f255` plus the ten changes above (git tree
`6581a05`), by the same runner and the same gate-skipping method as the baseline:

| | Baseline | After |
|---|---|---|
| READY | **26 / 40** | **30 / 40** |
| planned by the model | 5 | 2 |
| with a model repair | 10 | 5 |
| wall clock | 49 min | 31 min |
| failures labelled `DEVLAUNCH_BUG` | 9 | 0 |

Newly READY: `nuxt/starter` (ref selection), `sveltejs/realworld` (argument forwarding,
then the deterministic Node 22 move that the engine-error signature now triggers),
`jellydn/fastify-starter` (bind variable), `dan5py/turborepo-shadcn-ui` (root install).
Both MDN static sites stay READY and are now planned by rule. **No regressions:** every
repository READY in the baseline is READY after.

Two fixes removed a first blocker and uncovered a second, and both second blockers are
the contract's rather than DevLaunch's. `ahfarmer/calculator`'s dev server now stays up
and compiles — and webpack 4 fails under Node ≥ 17's OpenSSL 3, whose workaround is a
`NODE_OPTIONS` the validator refuses by design. `angular-realworld`'s `ng serve` now
starts, and cannot bundle a stylesheet from a git submodule, which intake does not fetch
by design. The remaining ten failures are seven outside the contract and three the
repositories' own; each is named, with its evidence, in the report.

Labels now live per report (`labels.baseline.json`, `labels.after.json`), because the
same repository's label changes when a fix exposes the next thing down.

## 2026-09-29 — A static site is planned by rule

`mdn/beginner-html-site-styled` and `-scripted` are HTML, CSS and a script with no
manifest. Both reached READY in the baseline only because a model planned them — one as
`python -m http.server`, the other as `npx http-server` — and without a key, which is
DevLaunch's shipped default, both are `UNSUPPORTED_PROJECT`. A page with nothing to build
is the simplest application there is, and it needed a model.

An `index.html` at the working directory is now `staticIndex`, and with no `package.json`
it is served by `python -m http.server 8000` from the Python image DevLaunch already
ships — no new binary and no new image. The detector count is 23.

- **Never beside a `package.json`,** even one that could not be planned: a Vite app's
  `index.html` is a template pointing at `/src/main.tsx`, and serving it raw would be a
  READY page that cannot work.
- **Beside Python files that plan to nothing, it is served:** that is a site with a
  helper script. The first version declined this too; no test could tell the guard was
  there, and on reflection nothing justified it.
- **No `--bind 0.0.0.0`:** the fixture served identically without it, because
  `http.server` listens on every interface by default. A flag that changes nothing a test
  can see was removed rather than kept for show.
- **Fixture:** `static-site`. Before: no rule-based plan. After: READY, rule-based.
- **Mutations:** the analyzer never seeing `index.html`, and the two guards. All killed.

## 2026-09-29 — A project that needs Bun is told so, at once

Two corpus repositories cannot run here, by contract: `bun-hono-app` is written for the
Bun runtime, and `Bun-React-Template` starts Vite through `bunx --bun`. DevLaunch ships
Node and no Bun. Both were planned anyway, died on `sh: 1: bun: not found`, and one went
to a model to repair a runtime that does not exist. A repository DevLaunch cannot support
should get a specific failure, not a generic one after minutes of work.

The planner now checks the script it would run. If it invokes `bun` or `bunx` as a
command, another candidate that does not is started instead, with a warning; with none,
the repository is declined as unrunnable — so no model is asked — with the script named
and a Bun-specific remedy. `PlanningOutcome` gained an optional `remedy` for that, which
the session uses in place of the library-shaped default.

Deliberately not a lockfile rule. `bun.lock` sits in two corpus repositories that install
and run under npm (a Vite app, and `angular-realworld`, whose unused `setup` script calls
bun); both still pass. Supporting Bun itself would mean an approved image and a new
binary on the allowlist, which is a decision rather than a fix.

- **Fixture:** `node-bun-runtime`. Before: planned as `npm run dev`. After: FAILED,
  `UNSUPPORTED_PROJECT`, naming the script, with the model never asked.
- **Mutations:** five — never detecting Bun, matching `bun` inside a word, no fallback
  to another script, the specific remedy dropped, and the outcome not marked unrunnable
  (which asks the model). All killed, each by the test that names it.
- `scripts/corpus/plan.mts` built its `ProjectPlanner` without a planner; fixed, and it
  now falls through to the root planner the way a session does.

## 2026-09-29 — The variable a server binds by, when it is not HOST

`jellydn/fastify-starter` listens on `host: process.env.SERVER_HOSTNAME ?? '127.0.0.1'`.
DevLaunch set `HOST`, which it does not read, so it bound loopback and ended
`PORT_BOUND_TO_LOCALHOST` — after a model call that changed nothing — while the variable
that fixes it sat in the same call.

`findBindHostVariable` reads the entry file's `.listen(...)` arguments for a
`process.env.X` used as the host: in an options object, as the second argument, or
through a `host`/`hostname` constant the call is given. The planner sets `X=0.0.0.0`
beside `HOST`, on both the script path and the entry-file path. Deliberately nothing
wider: `process.env.DB_HOST || 'localhost'` has the same shape, and a test holds it out.

The variable is looked for *before* the hardcoded-bind check, which read the default
`'127.0.0.1'` in a one-line form of the same call as a literal bind and reported a fixable
server as unfixable.

- **Precision, measured:** across all forty corpus clones it matches one repository —
  this one.
- **Fixture:** `node-bind-env`. Before: `PORT_BOUND_TO_LOCALHOST` on `127.0.0.1:3000`.
  After: READY.
- **Mutations:** eight — each argument form unread, `HOST` not excluded, a constant taken
  without the call using it, the literal checked first, and each planner path losing the
  variable. All killed. The entry-file path was first reported killed when it had
  survived; it gained the test that kills it. The false kill was blamed here on a flaky
  Docker test. It was the mutation harness: see "A runtime too new is named", above.

## 2026-09-29 — A workspace with one application installs at its root

`dan5py/turborepo-shadcn-ui` is a pnpm workspace with one runnable package, `apps/docs`.
`planRepository` planned that package from its own metadata: no lockfile and no
`packageManager` there, so npm, installed inside `apps/docs` — and npm refuses
`workspace:*` with `EUNSUPPORTEDPROTOCOL`. The root's `pnpm-lock.yaml` and
`packageManager` were never consulted. The project planner has installed a workspace at
its root since workspaces were supported; this path, which runs when only one package is
runnable, never did.

It now uses the same `workspaceInstall(root)` and the same override: the root's install
command, run at `.`, with the package's own start command.

- **Fixture:** `node-workspace-one-app`, a pnpm workspace whose one app imports a sibling.
  Before: `DEPENDENCY_INSTALL_FAILED`, `Unsupported URL Type "workspace:"` — the corpus's
  evidence, verbatim. After: READY, serving the sibling's string.
- **Mutations:** no override, the root command in the package directory, and the
  package's command at the root. All killed.

## 2026-09-29 — MySQL is reported ready when it is

No MySQL had ever been reported ready. The readiness check was `mysqladmin ping` run
inside the database container, as its own user `mysql`, with no `-u` — so mysqladmin
connected as `mysql`, was refused (`Access denied for user 'mysql'@'127.0.0.1'`), and
never printed `mysqld is alive`. The run waited out the full budget, logged "mysql did not
become ready; the project will fail" beside mysqld's own "ready for connections", and
where the compose file named an image (`fastify/demo`'s `mysql:8.4`) fell back to the
stock one to fail the same check again. The application then connected without trouble:
the database had been fine all along. The check has been wrong since MySQL provisioning
was introduced (`4a7ea9d`); nothing ran it against a real MySQL.

The check now names `-u root`, the account the container is created with.

- **Verified by hand first:** in `mysql:8` under the same user, the old command printed
  `Access denied`; with `-u root`, `mysqld is alive`.
- **Fixture:** `node-needs-mysql`, which depends on a stand-in named `mysql2` (detection
  reads only the name) and answers after reading MySQL's handshake packet. Before: READY
  after a 90-second wait, with the provisioner reporting the database dead. After: the
  provisioner reports it ready, and the application reads `mysql 8.4.11` from it.

## 2026-09-29 — A Create React App dev server survives having no stdin

`ahfarmer/calculator` printed "Starting the development server..." and ended `COMPLETED`
— "the expected shape for a script" — about a plan DevLaunch had just built as a CRA dev
server on port 3000. From 3.4.1, `react-scripts/scripts/start.js` closes the dev server
when stdin ends, unless `CI=true`; a container's stdin has ended before the server starts.
CRA plans now set `CI=true` beside `BROWSER=none`. It changes nothing else about `start`
(it makes `build` treat warnings as errors, which a dev-server plan never runs).

- **Fixture:** `node-cra-stdin`, whose stand-in `react-scripts` reproduces that handler.
  Before: `COMPLETED`. After: READY.
- **Mutations:** `CI` unset, and set to `false`. Both killed.
- **Not changed, and worth a decision:** a single-service plan that exits 0 before
  readiness is `COMPLETED` by design (`failure-model.md`, "Exiting 0 is not a failure"),
  while a project's service in the same position is a failure ("the start command
  finished instead of serving"). For a plan DevLaunch built as a dev server the second
  reading is the true one, and it would have named this bug instead of calling it success.

## 2026-09-29 — A failure is explained by the phase that failed

Three corpus repositories were misdiagnosed, and each misdiagnosis cost something:

- `fastify/demo` failed on `node: .env: not found` — its dev script is
  `tsx --env-file=.env`, and the repository ships `.env.example`. It was reported as
  `WRONG_RUNTIME_VERSION` from npm's `EBADENGINE` *warnings* during an install that
  succeeded, with the evidence line `npm warn EBADENGINE }`, and a repair moved it to
  Node 22 to fail identically.
- `angular-realworld`'s `ng serve` refused a flag; the report quoted husky's
  install-time `git command not found` as the start command that could not be run.
- `sveltejs/realworld` failed on pnpm's fatal `ERR_PNPM_UNSUPPORTED_ENGINE`, which no
  signature knew. It was a generic install failure and went to the model; the
  deterministic Node 22 move that answers it never fired.

`LogManager` now records where each sentinel fell — sentinels never enter the buffer, so
nothing had — and `phaseLog` gives the classifier the log from the failed phase's opening
marker. `lastErrorLine`, `lastOutputLine` and `stalledStartup` describe the running
application and read from the start marker. With no marker, all of it, as before.

A signature may now `exclude` lines that are never its evidence: the runtime-version
signature ignores npm, pnpm and Yarn warnings. `ERR_PNPM_UNSUPPORTED_ENGINE` is
recognised, and `env-file-missing` reports `node: <file>: not found` in the start phase as
`MISSING_ENV`, naming the file.

- **Fixture:** `node-install-noise`. Before: `WRONG_RUNTIME_VERSION`, evidence
  `npm warn EBADENGINE }`, exactly as in the corpus. After: `MISSING_ENV`, evidence
  `node: .env: not found`; a refused flag is quoted as itself; a process that never
  listens is not blamed on husky.
- **Found by the test, not the corpus:** the first version sliced the classifier's input
  and missed `lastErrorLine`, which builds the port failure's evidence before the
  classifier sees it. The readiness-path case failed on the fixed code and named it.
- **Mutations:** eleven, all killed. The first pass reported two call-site mutants as
  killed when they were not: the kill came from an unfixed case in the same test file.
  Every mutation since runs filtered to the tests that concern it.

## 2026-09-29 — `--disable-host-check` only where Angular accepts it

Every Angular plan ended in `--disable-host-check`, and `gothinkster/angular-realworld-example-app`
(Angular 21) refused to start: `Error: Unknown argument: disable-host-check`. `ng serve`
validates its flags against the schema of the builder `angular.json` names, and reading
the published schemas settled which builders have it: `@angular-devkit/build-angular`'s
dev server declares `disableHostCheck` in every version from 15 to 20;
`@angular/build:dev-server` — the builder every project generated since Angular 18 uses —
has never declared it, in 18, 19, 20 or 21.

The analyzer now reads the serve target's builder (`architect` or `targets`, the first
project that has one) into `angularDevServer`, and the flag is dropped for
`@angular/build`. An older builder, or one that cannot be read, keeps it: those need it to
answer through a port mapping at all. The Vite-based server behind `@angular/build`
accepts `localhost` and IP Host headers, which is what reaches it here.

- **Fixture:** `node-angular-build`, whose stand-in `ng` validates flags against the
  builder the way the real CLI does. Before: `START_COMMAND_FAILED`, evidence
  `Unknown argument: disable-host-check`. After: READY.
- **Mutations:** six — the flag never dropped, always dropped, the builder not passed to
  the planner, never read, read only under `architect`, and taken from a project with no
  serve target. All killed.

## 2026-09-29 — Flags reach a pnpm or Yarn 4 script as options

`sveltejs/realworld` ended `PORT_BOUND_TO_LOCALHOST` against a plan reading
`pnpm run dev -- --host 0.0.0.0 --port 5173`. Measured in the runner image rather than
recalled: pnpm 9.12, 10.20 and 12.6 and Yarn 4.6 all hand the script
`["--","--host","0.0.0.0"]` — they forward the `--` — while npm and Yarn 1 strip it.
Vite's argument parser reads everything after `--` as positional, so the flags that bind
the server to `0.0.0.0` never arrived, under every pnpm or Yarn 4 Vite, SvelteKit, Astro
or Nuxt project.

`runScript(pm, script, args)` puts `--` in front of the arguments under npm only, which
needs it — without it npm reads `--host` as its own configuration. `planning-strategy.md`
stated the npm behaviour as a rule for every manager, and is corrected.

- **Fixture:** `node-pnpm-vite-args`, a pnpm project whose `vite` is a vendored stand-in
  with cac's end-of-options behaviour. Before: `PORT_BOUND_TO_LOCALHOST` on
  `127.0.0.1:5173`, as in the corpus. After: READY.
- **Mutations:** four — `--` for every manager, for none, for Yarn, and a separator with
  no arguments. All killed.

## 2026-09-29 — A corpus of real repositories, and a clone of the commit it names

DevLaunch had been measured against real repositories twice, both times by a harness in a
session scratchpad that nobody could re-run, against whatever each default branch
happened to hold that day. A result that cannot be reproduced cannot show a regression.

### 1. `scripts/corpus/` — forty pinned repositories, through the real pipeline

`corpus.json` pins forty public repositories to commit SHAs, chosen for coverage rather
than for passing: static HTML, Vite with React, Vue and Svelte, CRA, Next, Nuxt,
SvelteKit, Astro, Remix, Angular, Express, Fastify, NestJS, TypeScript Node, Flask,
FastAPI, Django, Streamlit, Gradio, pnpm, Yarn 1 and 4, bun, Turborepo, Nx, Poetry,
Pipenv, `.nvmrc`, `.node-version`, and a repository whose default branch is not its
application. `run.mjs` deploys each over the backend's own HTTP API — nothing stubbed —
and writes `reports/<name>.{json,md}`: detection, plan source, final state, failure code,
stage, evidence line, repairs and duration, grouped by failure code and by label.

- It refuses to measure a stale backend (`/api/health` `build.stale`).
- A READY whose URL does not answer is counted `FALSE_READY`, never a pass: the runner
  requests every URL a session hands out.
- `labels.<report>.json` classifies each failure `DEVLAUNCH_BUG`, `REPO_FAILURE` or
  `UNSUPPORTED_BY_CONTRACT`, with the reason; `--report-only` re-renders with new labels.
- `logs.mjs` prints a corpus session's log from the backend that ran it; `plan.mts` runs
  the analyzer and planner on a local clone, with no server and no containers.
- A configuration gate is skipped once, and the report names every variable left unset.
  The gate is skippable by design, and skipping it is the only way to learn whether the
  application runs at all; `--keep-gate` measures the gate instead. A package choice is
  never guessed.

**Baseline** (`reports/baseline.md`, backend `c68f255`): **26 / 40 READY**, 49 minutes,
5 planned by the model and 10 with a model repair. Of the 14 failures, 9 are DevLaunch's,
3 are outside the contract (the Bun runtime twice, a Python pin with no 3.12 wheel) and 2
are the repository's (a generator CLI, and a cookiecutter template).

### 2. A session can name a branch, tag or commit

`GitManager.clone` always took the default branch. `nuxt/starter` keeps its application
on `v3` and a directory of templates on its default branch, and no repository could be
pinned at all. A clone now takes an optional ref: the same shallow, submodule-free,
size-bounded fetch, of exactly that ref, checked out detached. The commit actually
checked out is recorded, logged, and returned on the session as `commit`.

- `POST /api/sessions` accepts `ref`, and reads one out of a pasted
  `https://github.com/owner/repo/tree/<ref>` URL — the page a person was looking at. An
  explicit `ref` wins.
- The ref reaches `git fetch` as an argument, so it is held to a narrow shape — letters,
  digits, `.`, `_`, `-`, `/`; nothing beginning with `-`, no `..`, `//` or `@{` — and
  refused with 400 before a session exists, like a refused URL.
- A ref the remote does not have is `UNSUPPORTED_PROJECT` naming the ref, not
  `NETWORK_FAILURE`.
- **Mutations:** eleven, ten killed. The survivor was URL-decoding of a `/tree/` ref,
  which no test could distinguish because every character a ref may contain is already
  URL-safe. It was deleted rather than kept.

## 2026-09-29 — The ceiling follows the machine, and a workspace installs once

Two changes to the same failure. `horusyeung/nextjs-nestjs-fullstack-starter` died with
OUT_OF_MEMORY during install: both services started, both ran `pnpm install` on the same
workspace at the same time, and the VM could not hold two copies of that dependency tree.
The memory repair then raised each container to a hard-coded 2048 MB regardless of how
much the VM actually had.

### 1. The memory ceiling is derived from the VM

`containerMemoryCeilingMb(env, vmBytes)` returns an explicit
`DEVLAUNCH_CONTAINER_MEMORY_CEILING_MB` when set, otherwise half the VM capped at
4096 MB. `DockerManager.hostMemoryBytes()` reads `docker info` MemTotal, through the same
daemon the containers run on, and returns null rather than throwing.

There is deliberately **no floor**. The first version kept the old 2048 constant as a
minimum, so a small VM would not get weaker repairs than before — which on a 2 GB machine
offers one container the entire thing, with the daemon and possibly a database already
inside it. That is the exact wedge the ceiling exists to prevent. The constant now
applies only when the VM size cannot be read at all.

- **Verified:** `docker info` reports `6197440512` bytes (5910 MB) on this VM; the
  derived ceiling is 2955 MB, and the repair raises to it. A 2 GB VM derives 1024 MB,
  which equals the default container size, so no raise is offered and the session reports
  the machine as the limit instead of restarting into the same kill.
- The "already at the ceiling" message now names where the number came from — *"half of
  the 5910 MB this Docker VM has"* — rather than blaming
  `DEVLAUNCH_CONTAINER_MEMORY_CEILING_MB`, a variable the reader had almost certainly
  never set.

### 2. A shared workspace installs one service at a time

`ProjectPlanner` marks a workspace project `sharedInstall`, and every service is pointed
at one root install command. `ProjectExecutor` then waits for each service's install to
finish before starting the next — for shared workspaces only, and never for the last
service, which has nothing queued behind it.

The wait is bounded by `timeToReadyMs` and proceeds on timeout; a stuck install is
diagnosed by readiness like any other failure rather than hanging the project. The
liveness poll asks **Docker** whether the container is still alive, not our own state,
which is not written until readiness — after this loop. An OOM-killed container stalled
the wait for the full ten minutes before that was corrected.

- **Verified:** with the last-service exemption removed, the gate's own suite takes
  120 s instead of 0.1 s — the timeout, paid once per run, for nothing.

### 3. A dead container is diagnosed, not described

A container that has exited publishes no port, so `waitForReady` reported *"Docker
published no host mapping"* — a symptom of the death rather than its cause. For an OOM
kill that was actively harmful: the memory repair keys off `OUT_OF_MEMORY`, so the wrong
code meant the one repair that would have fixed the run never fired.

`waitForReady` now inspects the container first. It attributes `OUT_OF_MEMORY` on the
kernel's OOM flag — the only evidence a SIGKILLed process leaves — and
`APPLICATION_EXITED` otherwise, and it refuses to attribute anything at all when the
container was merely removed or could not be inspected. Exit 0 is reported in its own
words: the start command finished instead of serving, which means the plan starts the
wrong thing, and sending the reader to look for a crash that printed nothing wastes their
time.

### What an independent verifier caught

A blocker, and it is the reason the tests here are shaped the way they are:
**`waitForInstall` listened on the wrong channel.** `LogManager.ingest` emits a sentinel
on its own `'sentinel'` channel and returns — sentinels never reach the buffer or
`'entry'` listeners. Listening on `'entry'` meant the feature could not work against a
real container at any time. Its tests passed because they pushed into the log buffer by
hand. They now drive the real Docker-framed ingestion path through `logs.attach()`, and
`src/__tests__/helpers/dockerFramed.ts` exists so the next test cannot make the same
mistake quietly.

The verifier also found that *every* behavioural change in the first draft except the
pure ceiling function survived its own deletion — four mutations, 784/784 still green.
The launch-loop gate, the planner flag, the ceiling wiring and the exit diagnosis now
have tests, and each was confirmed by mutation:

| Mutation | Result |
|---|---|
| gate removed entirely | 1 failed |
| gate waits without `sharedInstall` | 1 failed |
| last service waits too | 2 failed (and 120 s) |
| `sharedInstall` flag not set | 1 failed |
| root install command not applied | 1 failed |
| workspace never detected | 3 failed |
| VM never consulted for the ceiling | 3 failed |
| ceiling message blames the env var | 2 failed |
| removed container treated as an exit | 1 failed |
| `-1` printed as a real exit code | 1 failed |
| exit 0 described as a crash | 1 failed |
| OOM flag ignored | 1 failed |
| whole exit branch removed | 3 failed |
| install wait listens on `'entry'` again | 3 failed |
| any sentinel ends the wait | 1 failed |
| liveness probe rejection uncaught | 1 failed |

- **Full suite:** 889 passed, 3 skipped, 0 failed, 46 files (backend); 63 passed
  (frontend). `STRICT=1 scripts/verify-readiness.sh` → 33 passed, 0 failed.

### Disputed and not changed

The verifier reported that `sharedInstall` is set only on the rule-based path and not on
the AI-fallback path. It is not a gap: `ProjectPlanSchema.parse` is called in exactly one
place (`ProjectPlanner.ts:138`), and the AI fallback (`SessionManager.ts:489`) produces a
single-service `RunPlan`. One service has no sibling to race with, so there is nothing to
sequence.

### Known limitations

- Sequencing installs costs wall-clock on a cold cache — one install's duration per
  service, for shared workspaces only. That is the trade being made deliberately: peak
  memory is bounded to one install, which is what was failing.
- The derived ceiling is read once per SessionManager and cached. Resizing the VM while
  the backend is running will not be noticed until it restarts.
- `horusyeung/nextjs-nestjs-fullstack-starter` reaches PARTIALLY_READY, not READY: `api`
  serves `{"name":"Full-Stack Starter API",...}` on `http://localhost:3001/` with HTTP
  200, while `web` fails honestly with `READINESS_TIMEOUT` because a Next.js dev server's
  first compile exceeds the 60 s readiness budget. Not addressed here.

### Explicitly not done

- The `config/index.ts` evaluation-order trap (constants read before `loadDotEnv()`) is
  unchanged and still recorded as open in `docs/production-readiness.md`.
- No live re-run of the full 28-repository sweep after these changes; the evidence above
  is the suite, the mutations and the readiness script.

## 2026-09-29 — Closing the readiness findings

F1–F7 closed, F8 half-closed by decision. `docs/production-readiness.md` carries each
finding's status; this records the mechanisms and what an independent verifier caught.

### 1. The API answered on the local network

`server.ts` called `http.listen(port, r)` with no host, so Node bound `::`. DevLaunch has
no authentication — deliberately, because it is a single-user local tool — and
`POST /api/sessions` clones a URL and runs it. Those are only compatible while the port
is unreachable from elsewhere, and it was reachable.

`bindHost()` defaults to `127.0.0.1`; `DEVLAUNCH_HOST` widens it and startup warns when
it is wider. The log socket shares the listener, so it is covered by the same change.

- **Verified:** `TCP 127.0.0.1:3939 (LISTEN)`; `curl http://192.168.0.2:3939/api/health`
  → `000` (refused), where it returned `200` before; `curl localhost:3939` → `200`.
- **Known limitation:** deliberately not in `config/index.ts`. That module is evaluated
  before `loadDotEnv()`, so a value read there honours an exported shell variable and
  silently ignores the same line in `.env`. Acceptable for a timeout, not for a security
  default. The same trap applies to every `intEnv` constant and is recorded as open.

### 2. A refused URL was accepted first

The route passed `body.repoUrl` straight to `launch()`; the rejection arrived
asynchronously. A typo looked accepted and held the only session slot until it finished
failing. `normaliseRepoUrl` now runs in the route, before the concurrency check.

- **Verified:** `POST {"repoUrl":"https://gitlab.com/a/b"}` →
  `400 {"error":"Only github.com is supported, got \"gitlab.com\".","code":"UNSUPPORTED_PROJECT"}`,
  and `sessions.list()` unchanged.

### 3. Cache volumes were never reaped

Teardown removed containers; nothing removed volumes. 99 had accumulated — 5.116 GB, 98%
reclaimable. `CleanupManager.sweepStaleCaches` removes those older than
`DEVLAUNCH_CACHE_MAX_AGE_DAYS` (14) at startup, filtered on DevLaunch's own cache label.

- **Impact:** existing volumes age out rather than being deleted retroactively. Reclaim
  now with `docker volume prune --filter label=com.devlaunch.cache`.
- **Known limitation:** an unparseable `CreatedAt` is treated as brand new, so a volume
  with a bad timestamp is spared rather than deleted. Safe direction, deliberately.

### 4. The egress policy was assumed, not checked

`docs/limitations.md` said the iptables rules "do not survive recreating that VM". They
do not survive restarting it either, and nothing noticed. `EgressProbe` starts one
container on `devlaunch-net` and tries to reach 169.254.169.254; reaching it proves the
policy is absent. Behaviour rather than reading iptables, because the rules live in the
VM and the backend runs on the host.

- **Verified:** `/api/health` → `"egress":"enforced"` against the live network, no
  container left behind.
- **Known limitation:** re-probed at most every five minutes, and only when something
  reads the verdict. A policy that vanishes is noticed on the next read, not instantly.

### 5. Health could not be unhealthy; failures went unrecorded

`ok` was the literal `true`. It now names the broken dependency — Docker unreachable
(bounded at 3s, because a wedged daemon is the realistic case) or the egress policy
absent — and unhandled rejections are kept and surfaced there.

### Testing

- 814 → **858** backend, 63 frontend, 3 skipped, zero failures. Baseline recorded before
  any edit and matched after.
- Mutation-tested: 23 mutations across the bind, the route, the reaper, the probe, health
  and the AI boundary. Six survived initially and each forced a better test.
- `./scripts/verify-readiness.sh` → 26 passed, 0 failed. `STRICT=1` exits 1, correctly
  reporting F8's deliberate partial.
- Not verified: the CI workflow has never run — GitHub Actions is not enabled on this
  repository, so `.github/workflows/ci.yml` is asserted by reading, not by execution.

### What an independent verifier caught, after I thought it was done

Kept because the misses are the useful part.

- **Three AI-boundary tests were named for a control they never exercised.**
  `bash -c "whoami"` was refused by the *quote* rule, the pipe case by the *pipe*, the
  repair case by the *semicolon*. Deleting `ALLOWED_BINARIES` entirely left all but one
  green. Rewritten with metacharacter-free commands and assertions on the message; three
  now go red when the allowlist is gutted.
- **The egress probe could report a false all-clear.** Absence of the `REACHED` sentinel
  was read as "blocked", so a missing binary, a failed network attach or an unreadable
  log all produced `enforced`. Both outcomes are spoken aloud now, and silence is
  `unknown`.
- **The probe's container bypassed every hardening invariant the project asserts** — no
  `CapDrop`, no read-only rootfs, running as root: the one unhardened container on the
  machine, created by the code whose job is hardening. It uses `buildHostConfig` now.
- **`DEVLAUNCH_CACHE_MAX_AGE_DAYS=0` did not disable the reaper.** `intEnv` substitutes
  its default for anything `<= 0`, so the documented escape hatch quietly meant fourteen
  days, and the log line hardcoded "14" regardless of the setting.
- **The rejection handler made crashes quieter, not more durable.** Installing an
  `unhandledRejection` listener suppresses Node's default of printing the stack and
  exiting; the replacement was one `console.error`. Now bounded, kept, and surfaced on
  `/api/health`, with the trade stated rather than implied.
- **`STRICT=1` was dead code.** The counter it read stopped being incremented when F1
  closed, so "STRICT exits 0" was true because the flag did nothing.
- **The script's only runtime bind check skipped whenever nothing was listening** —
  which is always, in CI, where it runs. It starts a server to find out now.

### Known open items, deliberately not addressed

- **Structured logging and counters (the rest of F8).** Both need a dependency on a
  project that hand-wrote a six-line `.env` loader rather than take one. Decided with
  the user; `STRICT=1` reports it as not fully closed.
- **`config/index.ts` ignores `.env`.** Every `intEnv` constant honours an exported
  variable and silently ignores the file. Found while fixing F1, outside its scope.
- **Supply-chain scanning, cache poisoning, startup with Docker absent.** Named in the
  report's "Not examined" section; still not examined.

## 2026-09-28 — Production-readiness verification

No behavioural change to DevLaunch. This entry records a verification and what it found,
including what the first attempt at it got wrong.

Artifacts: `docs/production-readiness.md`, `scripts/verify-readiness.sh`,
`.claude/tasks/2026-09-28-production-readiness/`.

### 1. The API is reachable from the local network, and executes what it is given

Not a regression — it has always been true, and nobody had looked.

`apps/backend/src/server.ts:117` calls `http.listen(port, r)` with no host argument, so
Node binds `::`. `POST /api/sessions` clones a URL and runs its contents, and there is no
authentication anywhere, by design, on the reasoning that a local tool does not need it.
That reasoning holds only while the tool is local, and the bind makes it not.

- **Impact:** anyone on the same network can run arbitrary code in a container on this
  machine, and stream the log output of whatever else is running — the WebSocket shares
  the listener and has no origin check either.
- **Verified:** `lsof -nP -iTCP:3939 -sTCP:LISTEN` → `TCP *:3939 (LISTEN)`;
  `curl -o /dev/null -w '%{http_code}' http://192.168.0.2:3939/api/health` → `200` from
  the LAN address; `grep -cE "origin|verifyClient" LogSocketServer.ts` → `0`.
- **Known limitation:** not fixed here. This task was a measurement, and fixing is a
  separate approved change. One line plus a config entry.

### 2. Cache volumes are never reaped

Teardown removes containers. Nothing removes the per-repository cache volumes, and the
orphan sweep at startup covers containers only.

- **Impact:** unbounded disk growth on a tool whose job is cloning arbitrary
  repositories, plus a writable surface that persists across runs of the same repository.
- **Verified:** `docker volume ls -q | grep -c devlaunch` → `99`;
  `docker system df` → `Local Volumes 106 / ACTIVE 1 / 5.116GB / RECLAIMABLE 5.032GB (98%)`.
  One of the 99 was created by this verification's own smoke test.
- **Known limitation:** found by the independent verifier, not by me. The first draft of
  the report claimed the machine was left as it was, on the strength of a container count.

### 3. The egress policy does not survive a VM restart

`docs/limitations.md` says the rules "do not survive recreating that VM". They do not
survive restarting it either, which is far more common, and nothing notices.

- **Impact:** containers run with weaker isolation than documented, silently.
- **Verified:** after `colima stop && colima start --cpu 4 --memory 6`,
  `colima ssh -- sudo iptables -S DOCKER-USER` → `-N DOCKER-USER` and nothing else.
  After `./scripts/setup-network-policy.sh` → `-A DOCKER-USER -s 172.31.250.0/24 -j DEVLAUNCH`.
- **Known limitation:** reapplied manually during this session; no automatic check added.

### 4. The AI path is not exercised by the suite

`814 passed | 3 skipped` reads as complete coverage. The three skips are the entirety of
`integration/groqLive.test.ts` — the only tests of the component that turns untrusted
repository content into a plan that is then executed.

- **Verified:** `vitest run --reporter=json`, filtered for skipped, names all three.

### Testing

- New: `scripts/verify-readiness.sh`, 15 assertions derived from `requirements.md` rather
  than from the report. Proven able to fail: dropping `CapDrop: ['ALL']`, changing the
  intake host default, and removing the credentials check each turn it red; `STRICT=1`
  exits 1 while any finding is open.
- Baseline before and after, unchanged: backend `814 passed | 3 skipped`, unit
  `727 passed`, frontend `63 passed`, zero failures throughout. No source file was
  modified, so no regression was possible; the baseline exists to prove that.
- Smoke, end to end against a real repository: `https://github.com/pj8912/todo-app` →
  READY at `http://localhost:32873/` → `HTTP 200`, 323 bytes of the application's own
  HTML → cancelled → `0` managed containers.
- Not verified: `docker compose up -d` and the Ubuntu 22.04 / Docker 24.x target the brief
  assumed, because the project ships no compose file and no such host exists here.

### What the first draft of the report got wrong

Kept because a verification report that cannot admit its own misses is not evidence of
anything. An independent verifier with fresh context found:

- **Nine claims asserted without a command or output**, including the container-hardening
  and egress results, which were presented as observations but printed like source reads.
- **A smoke test that never exercised the path it claimed to.** It submitted
  `{"fixture":"node-http-basic"}`; that branch bypasses cloning and intake entirely, so
  the primary workflow was never demonstrated. Redone with a repository URL.
- **An arithmetic error**: 15 READY + 2 partial + 10 failed = 27, not the 28 swept. The
  missing row was `AWAITING_INPUT`.
- **Intake messages quoted as verbatim that were silently truncated.**
- **F1 graded HIGH in a document whose top band was HIGH** — a ceiling, not a judgement.
  Now CRITICAL, with the log socket included in its blast radius.
- **The volume leak above, missed entirely.**

### Known open items, deliberately not addressed

- **The bind address (F1)** — the fix is one line plus a config entry; this task was
  explicitly a measurement, and changing behaviour needs its own approval.
- **Prompt injection through repository content** — named in the report as F2, not
  demonstrated. No fixture carrying adversarial README text exists yet.
- **Supply-chain scanning** — no `npm audit`, no image CVE scan, no `gitleaks` run.
- **Startup with Docker absent** — never tested.

## 2026-09-18 — Readiness was timing the wrong thing

Reported from a real run against a large FastAPI project:

```
PORT_NOT_LISTENING during start
Nothing is listening on port 8000. Sockets observed: 127.0.0.11:41749.
```

The only socket observed is Docker's own DNS. Nothing was listening because nothing had
been started: `pip install -e .` was still resolving, and pip said so itself —
`This is taking longer than usual… See backtracking for guidance`.

Install and build run *inside* the container, before the wrapper `exec`s the start
command. The readiness clock was started when the container started, so a sixty-second
budget expired while a multi-minute install was still going. DevLaunch then reported a
failure the application had not committed — and, because `READINESS_TIMEOUT` is
repairable, "fixed" a plan that was never wrong and ran the whole install again. The log
shows that install three times.

Readiness now waits for the `START` sentinel before its clock begins, bounded by the
time-to-ready budget. An install that never finishes within that budget is reported for
what it is — `PROCESS_TIMEOUT` against the install or build phase, naming
`DEVLAUNCH_TIMEOUT_TIME_TO_READY_MS` in the remedy — rather than as a port that never
opened.

- New fixture `python-slow-install`: an install that takes 75 seconds against a 20-second
  readiness budget, then a normal start. **Proven able to fail:** starting the clock at
  container start reproduces the reported failure exactly, Docker DNS socket included.
- 487 tests across three packages (484 passing, 3 skipped), zero residue.

### What this does not fix

A dependency tree that genuinely takes longer than the time-to-ready budget still needs a
larger budget. Ten minutes is the default; a resolver that backtracks through dozens of
versions of a dozen packages can exceed it, and the honest answer is to raise the budget
or constrain the requirements — which is what pip's own advice says.

## 2026-09-18 — "No space left on device", on a disk that was 8% full

Reported from a real run:

```
ERROR: Could not install packages due to an OSError: [Errno 28] No space left on device
```

The Colima VM was using 1.4 GB of 19 GB, and the workspace volume had 88 GB free. The
disk the message names was nearly empty.

`/tmp` is a 64 MB tmpfs. That is deliberate — it is memory, mounted `noexec,nosuid` so it
cannot be used to stage an executable payload — and pip unpacks and builds there by
default. One ordinary wheel exhausts it. Every Python project with a real dependency
failed this way, and the error pointed at the wrong thing.

`TMPDIR` now points at `/workspace/.tmp`: disk-backed, already writable and executable by
the running user, and tens of gigabytes rather than 64 MB. `/tmp` keeps its `noexec`
mount for everything else, so nothing is weakened — the workspace was always writable and
executable, because that is where `node_modules/.bin` lives.

### A regression this caused, caught before it shipped

Setting `TMPDIR` in the image broke pnpm outright:

```
Error: ENOENT: no such file or directory, lstat '/workspace/.tmp'
```

pnpm resolves `TMPDIR` the moment it starts, so `pnpm -v` alone failed. The directory is
now created in the image as well as by the wrapper — an anonymous volume is initialised
from the image path it shadows, so it survives into the mount.

### The remedy was pointing at the wrong place too

The `disk-full` signature said to reclaim space in the VM. Almost always wrong: the
tmpfs is what fills, while the disk beside it is empty. It now names the likely cause
first and the genuinely-full-disk case second.

### Verified

A `pandas` install under the full runtime profile — read-only rootfs, 64 MB tmpfs,
`--cap-drop ALL`, `no-new-privileges`, 1 GB memory, 256 pids — completes, and the package
imports. Reverting `TMPDIR` to `/tmp` reproduces the reported error exactly, which is what
the new test asserts against.

- 486 tests across three packages (483 passing, 3 skipped).
- **One unexplained failure**, in the first of four full runs: the cross-service
  name-resolution test reported `FAILED` where `READY` was expected. It passed alone
  immediately afterwards and in three consecutive full runs since. Manual sessions were
  being started against the same daemon around that time, which is the alias-collision
  case documented in `limitations.md`, but that is a plausible explanation rather than a
  demonstrated one.

## 2026-09-18 — A project that drives Docker gets told so

With the workspace install fixed, DevLaunch's own backend got as far as running its own
code and died on its own precondition:

```
Error: No Docker socket found. Tried: /var/run/docker.sock …
```

DevLaunch reported `PORT_NOT_LISTENING`. True, and the least useful true thing available:
it describes what was observed while the log two lines up names the cause.

### The verdict now says what is wrong

`DOCKER_SOCKET_REQUIRED` is the only code in the taxonomy that no configuration can fix.
Every other failure names something a person could supply, change or retry. This one says
the project cannot run inside a container that withholds the Docker socket — and
withholding it is the point, since mounting it hands any repository root on the host. The
honest remedy is "run this on your machine".

```
code    : DOCKER_SOCKET_REQUIRED
message : backend: The project needs to talk to the Docker daemon, which is
          deliberately not reachable from inside the sandbox.
evidence: Error: No Docker socket found. Tried:
remedy  : DevLaunch never mounts the Docker socket into a container — its absence is
          what stops a repository escaping the sandbox …
```

### Symptom versus cause, generally

The port branch now classifies against the log before reporting, so any diagnosable crash
in a *still running* container is named rather than described. That case exists because
watchers survive a crash in the code they watch: the container stays up, nothing binds,
and "nothing is listening" was the whole verdict.

A loopback-only bind is deliberately excluded. That one is read from the container's own
socket table, and a log line should not be able to overrule a measurement.

- 4 tests. **Proven able to fail:** dropping the signature, or reporting the symptom
  without consulting the log, each turn the new test red.
- 485 tests across three packages (482 passing, 3 skipped), zero residue.

### Not changed, deliberately

DevLaunch still cannot run DevLaunch, and should not. Making it possible means mounting
the host's Docker socket into a container, which would give every repository DevLaunch
runs — including one whose plan came from a model reading an untrusted README — root on
the machine. Docker-in-Docker is a real alternative, and a larger decision than a bug fix.

## 2026-09-18 — Workspaces install once, at the root

Running DevLaunch through itself failed at install, for both services:

```
[backend]  npm error code EUNSUPPORTEDPROTOCOL
[backend]  npm error Unsupported URL Type "workspace:": workspace:*
[frontend] npm error code EUNSUPPORTEDPROTOCOL
```

Each service was installed on its own, in its own container, from its own directory. Its
siblings are referenced as `workspace:*` — a protocol only the tool that wrote the
lockfile understands, and one npm rejects outright. No amount of retrying a
single-package install can resolve it.

A workspace now installs **once, at its root**, with the manager its lockfile implies:
`pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, otherwise npm. Each service still starts
from its own directory, so only the install moves.

Three things had to change together:

- **The wrapper can install somewhere other than where it starts.** `DL_INSTALL_DIR`,
  applied in a subshell so the build and start steps still run in `DL_WORKDIR`. It
  defaults to the working directory, so a single-service plan behaves exactly as before.
- **`RunPlan` gained `installDirectory`.** A plan that says where to install is the only
  way the wrapper can be told without interpolating a path into a command.
- **The runner image gained pnpm**, pinned at build time rather than fetched by corepack
  at run time, so a run needs no network to obtain its own tooling.

### The failure also said nothing useful

`DEPENDENCY_INSTALL_FAILED · uncertain` with an empty evidence line, while the npm error
sat in the log. There is now a signature for the workspace protocol, so the verdict names
the cause and the remedy.

Worse was the case after install succeeded. `tsx watch` — and every other watcher —
survives a crash in the code it is watching, so the container stays up, nothing binds,
and `Nothing is listening on port 3000` was the entire verdict while the reason sat two
lines above it. A failure with a running container now carries the application's own last
error. Picking that line needed care: a crashing Node process signs off with
`Node.js v20.20.2`, so taking the last stderr line returns something true and useless.

### DevLaunch cannot run DevLaunch, and should not

With the install fixed, its frontend reaches `READY` and its backend reports:

```
Error: No Docker socket found. Tried: /var/run/docker.sock …
```

Which is correct. DevLaunch containers never mount the Docker socket — that absence is a
stated security property — and DevLaunch's backend cannot work without one. The sandbox
is refusing exactly what it is meant to refuse.

- 5 tests. **Proven able to fail:** taking the last stderr line returns the version
  banner; reverting to per-package installs no longer compiles, since the field it sets
  is the only way to move the install.
- 483 tests across three packages (480 passing, 3 skipped), zero residue.

## 2026-09-18 — "A session is already running", and no way to get to it

The message was accurate and useless. It named a constraint, did not say which session
held the slot, and there was no endpoint to list sessions — so a client that had lost the
id could neither see the running session nor stop it. A page reload was enough to lose
it, because the id lived only in the dashboard's component state.

Encountered for real: the backend reported two sessions and Docker reported **zero**
containers, and the only way past it was restarting the process.

### Three things were wrong

- **Nothing bounded a session that never reached READY.** The lifetime clock starts at
  READY and the time-to-ready budget belongs to a *container*, so a session whose
  containers disappeared before readiness had nothing to end it. It kept the only slot
  indefinitely. A backstop at twice the time-to-ready budget now releases it, with a
  failure that says how far it got — deliberately generous, since this is for a session
  making no progress at all, not a second opinion on a slow install. `READY` hands over
  to the lifetime clock and `AWAITING_INPUT` has its own bound, so neither is cut short.
- **Sessions could not be listed.** `GET /api/sessions` now returns every session this
  process knows about, newest first, with whether it is still active.
- **The conflict did not say what to do.** The 409 now names the blocking session and its
  state, and carries its id, so the dashboard can offer to stop it.

### And the dashboard forgets less

On load it adopts whatever session is already running, so a reload reconnects to it —
pipeline, services, URL and live logs — instead of stranding it. A launch refused by the
concurrency limit shows a `stop it` button beside the error.

### Verified

```
POST /api/sessions -> 409
{
  "error": "A session is already running (started from a fixture, currently ready).
            DevLaunch runs 1 at a time … Stop it and try again.",
  "activeSessionId": "0287a54a-c7c0-4c6d-8bfe-e4aeb25d49ac"
}
```

Reloading the dashboard with that session running reconnected to it and streamed its logs.

- 4 tests. **Proven able to fail:** removing the backstop leaves the slot held forever;
  letting the backstop ignore `READY` kills a working session; dropping the id from the
  conflict makes it unactionable again.
- 480 tests across three packages (477 passing, 3 skipped), zero residue.

## 2026-09-18 — The configuration gate reads every service, not just the root

A repository keeps its configuration beside the service that reads it. `GROQ_API_KEY`
lives in `backend/.env.example`, and the gate read only the repository root — so it asked
for nothing, the container started without the key, and the failure arrived later as an
application crash with the reason buried in its own logs. That is the exact shape of
problem the gate exists to prevent.

### Asking is the easy half

The harder half is what *not* to ask for. DevLaunch supplies the database URL, the API
base, the permitted origin and the port itself, and asking a person for any of them is
asking them to guess a value that has not been decided yet — one that will either be
overridden, or respected and wrong. `requiredConfiguration` subtracts all of them before
asking anything, and the key names are knowable without the values, which is why it can
run before a single container exists.

Each request names the service that made it, because the same variable can mean different
things in two services. Values are routed back only to services that declare them: one
service's API key must not land in another's environment.

### Two port-detection bugs, both found against a real machine

The first attempt at this failed with `failed to set up container networking` from the
daemon. `isPortFree` probed the loopback addresses and reported a port as free while
Colima's forwarder held it on `*:5001`. Measured, against two ports genuinely in use:

```
held by Colima's forwarder on *:5001      held by a Vite server on ::1:5173
  bind 127.0.0.1 -> free                    bind 127.0.0.1 -> free
  bind ::1       -> free                    bind ::1       -> EADDRINUSE
  bind 0.0.0.0   -> EADDRINUSE              bind 0.0.0.0   -> free
```

Node sets `SO_REUSEADDR`, which on BSD lets a specific address bind alongside a wildcard
— so a loopback probe walks past every Docker-published port, and a wildcard probe walks
past anything bound to `::1`. Neither alone is enough; all three are now required.

### One project was answering another project's DNS

The suite then failed with `{"success":false,"error":"Route not found"}` where a fixture's
own JSON belonged. The web container had reached a **different project's** backend: a
manually started session and the test suite each had a service called `backend`, both
claiming the alias `backend` on the shared network, and Docker round-robins a duplicated
alias rather than refusing it.

Concurrency is one session per process, which says nothing about two processes. A bare
name is now claimed only when no running container already answers to it, and the session
scoped alias is always present. Declining is explained rather than silent, because a
repository that expects `http://backend:5000` needs to know why it is not answering.

### Verified

Against real containers, the fixture's backend declares `APP_SECRET` with no value and
refuses to start without it:

```
gate state: AWAITING_INPUT | asked: [{"key":"APP_SECRET","service":"backend"}]
final: READY
backend env: HOST=0.0.0.0 PORT=5000 APP_SECRET=from-the-gate
             MONGODB_URI=mongodb://mongodb:27017/… CORS_ORIGIN=http://localhost:…
[backend] database connected at mongodb:27017
```

Asked for one variable, attributed to one service; injected the other four without
asking; and the supplied value reached the process, not merely the plan.

- 9 unit tests, 1 integration test, 1 port test. **Proven able to fail:** reading only the
  root turns 2 red, asking for injected variables turns 3 red, giving every service every
  value turns 1 red, and a loopback-only port probe turns the wildcard test red.
- 476 tests across three packages (473 passing, 3 skipped), zero residue.

## 2026-09-18 — Multi-service, phase E: a dashboard for a project, and controls

Phases B–D made a project *run*. The dashboard still described it as though it were one
application: one pipeline, one state, one URL — which is the right gate and the wrong
amount of detail when one of four services is the problem.

### What this phase adds

- **A services panel.** Every service with its own state, its host → container port
  mapping, its URL, and what it is consuming. Provisioned databases appear too, labelled
  as provisioned rather than found, because they are not something a person can go
  looking for in their own repository.
- **Restart, per service or for the whole project.** The control a person reaches for
  when an application wedges or they have changed something it reads at boot; re-cloning
  is a heavy answer to a light question.
- **Resource monitoring.** CPU and memory per container, polled while a session runs.

### Restart keeps the address, which is what makes it safe to offer

A restarted service comes back on the same host port with the same resolved plan — the
injected `MONGODB_URI` and `CORS_ORIGIN` included. Both matter: the port was chosen by
DevLaunch and written into its siblings' configuration, so a restart that moved it would
break everything that had been told where to find it, and re-deriving the plan would
throw the injected values away.

The lifetime clock and liveness watch are disarmed for the duration — both key off
`READY`, and leaving them armed while containers are being replaced would have the watch
announce the application had died.

### Statistics are sampled, not streamed

`stats({ stream: false })` returns the previous CPU reading alongside the current one, so
a percentage comes from a single request. A dashboard polling every few seconds is the
whole requirement; a stats stream per container costs the same whether or not anyone is
looking. Sampling never throws — a container that has just exited has no numbers, and
that is not worth failing a page render over.

### A test that tested the wrong thing

The restart test asserted the port survived by reading DevLaunch's own record of it —
which stays unchanged whether or not the new container was published anywhere near it.
Restarting on a fresh port passed. It now reads the mapping back from Docker, and the
same mutation fails with `expected 35211 to be 5001`.

### Verified

Against the real repository, in a browser:

```
SERVICES                                      restart all
backend    called by the page   ready  5001 → 5000    http://localhost:5001/    10% cpu · 129/1024 MB  [restart]
frontend   browser              ready  62322 → 5173   http://localhost:62322/    0% cpu · 239/1024 MB  [restart]
mongodb    provisioned mongodb  ready  internal       reachable as mongodb       1% cpu ·  73/1024 MB
```

Clicking `restart` on the backend left the frontend and database untouched — 24 seconds
old against a minute — and the backend came back on 5001, still connected to MongoDB.

- 4 HTTP tests and 2 integration tests. **Proven able to fail:** restarting on a fresh
  port and restarting everything when one service was asked for each turn the
  integration test red.
- 465 tests across three packages (462 passing, 3 skipped), zero residue.

### What is still missing

`.env.example` is read only at the repository root, so a per-service secret is never
asked for — `GROQ_API_KEY` lives in `backend/.env.example` here, and this repository
ships a working default so it runs regardless. One that did not would fail with a
configuration error rather than a prompt. That is the next thing worth doing.

## 2026-09-18 — Multi-service, phase D: the browser can finally reach the API

Phase C left a healthy stack that still looked broken. Every service ran, the database
was connected, and the page said `Failed to fetch` — because the browser resolves
`http://localhost:5001` on the *user's machine*, where no container alias, network or
amount of correct orchestration reaches.

### Ports are chosen before anything starts

Docker assigning a host port is fine for a lone service and impossible for a project: a
frontend's `VITE_API_URL` and an API's `CORS_ORIGIN` both have to be written before
either container is created, and a port Docker has not assigned yet cannot be written
into anything. DevLaunch now picks the ports itself, preferring the one a sibling already
hardcodes — `http://localhost:5001` in a frontend's source is not a preference, it is the
only address that will ever be requested.

When the preferred port is taken, it says so plainly rather than substituting silently:

```
Port 5173 is in use on this machine, so frontend is published on 56767 instead.
A hardcoded reference to 5173 will not reach it.
```

### Two variables decide whether a working stack looks broken

Both are set from what each service *declares*, never guessed — the same rule the
database URL follows:

- the frontend's API base (`VITE_API_URL` and a dozen framework spellings), or every
  request the page makes is refused;
- the API's permitted origin (`CORS_ORIGIN`, `ALLOWED_ORIGINS`, …), or every request is
  refused *by CORS*, which looks identical from the browser and is not.

Inventing a variable is worse than doing nothing: `CORS_ORIGIN` on a service that reads
`ALLOWED_ORIGINS` achieves nothing, and on a service that reads neither it can narrow a
permissive default into a broken one.

`import.meta.env.X` is now scanned alongside `process.env.X`, because Vite and SvelteKit
expose configuration there and a frontend is exactly the service whose API base must be
injected. Without it the real repository's `VITE_API_URL` was invisible.

### A bug found only because a real machine had something else running

`isPortFree` probed `127.0.0.1` and called 5173 free. It was not: another project's dev
server held `::1:5173`, and `localhost` resolves to `::1` **first**. Docker published on
IPv4 and succeeded, the page loaded, and the browser had been talking to the other
application entirely — a different app's UI, served from DevLaunch's URL.

Measured on the machine that exposed it: `127.0.0.1:5173` bindable, `::1:5173` not, and a
dual-stack bind on `::` bindable too — so only an explicit `::1` probe sees it. Both
loopback stacks are now required to be free.

### Verified — the real repository works, end to end

`Prompt-Engine`, from nothing but a GitHub URL:

```
Access-Control-Allow-Origin: http://localhost:56767
POST /api/optimize → {"success":true,"_id":"6aac34664c04640bbb6260be",
                      "optimizedPrompt":"Act as a senior software engineer..."}
```

Frontend, backend, MongoDB, CORS and the API base URL — all wired, with a document
persisted to the database. Loaded in a browser: no console errors, and
`GET /api/history → 200`.

- 9 unit tests and 1 integration test. **Proven able to fail:** not publishing where the
  frontend looks turns 1 red; not wiring CORS turns 2 unit tests red and the integration
  test with it; probing IPv4 only turns the IPv6 test red.
- 459 tests across three packages (456 passing, 3 skipped), zero residue.

### What is left

A service's `.env.example` is still read only at the repository root, so a per-service
secret — `GROQ_API_KEY` lives in `backend/.env.example` here — is never asked for. This
repository ships a working default, so it runs regardless; one that did not would fail
with a configuration error rather than a prompt. The dashboard still shows one pipeline
and one URL for what is now several services, and there is no restart control or resource
monitoring: phase E.

## 2026-09-17 — Multi-service, phase C: the databases a project expects

Phase B ran every service. One of them still would not start:

```
[backend] ❌ MongoDB connection error: connect ECONNREFUSED 127.0.0.1:27017
[backend] Failed running 'server.js'
```

An application that connects to its database at boot gets exactly one chance, and there
was nothing to connect to.

### What this phase adds

MongoDB, Postgres, MySQL and Redis are provisioned per session when a repository's
dependencies or environment declare them, started *before* any application service, and
waited on with the image's own health command — `mongosh ping`, `pg_isready`,
`redis-cli ping`, `mysqladmin ping`. "Running" is not "accepting connections", and the
difference is a race the application loses.

Data lives in anonymous volumes, so it lasts exactly as long as the session. A
dev-launch tool that quietly accumulated database state across runs would be surprising
in a worse way than one that starts clean.

### Stock images, without giving up the hardening

Databases are upstream images, not DevLaunch's own, and the obvious way to run them is
to relax the profile. Measured instead: under `--cap-drop ALL` with `no-new-privileges`,
mongo's entrypoint dies with

```
chown: changing ownership of '/proc/1/fd/1': Operation not permitted
error: failed switching to 'mongodb': operation not permitted
```

because it wants to chown its data directory and then drop privileges. Running the
container **as the image's own unprivileged user** (uid 999, which all four define, and
which already owns their data directories) skips that path entirely. Every control the
runner images get is kept: capabilities dropped, rootfs read-only, no-new-privileges,
memory, CPU and pid ceilings, no Docker socket.

### The variable name is the whole game

A provisioned, healthy MongoDB still produced `connect ECONNREFUSED 127.0.0.1:27017`.
The URL had been injected as `MONGO_URI`; the application reads `MONGODB_URI`. An
injected variable nobody reads is indistinguishable from no database at all.

The name was discoverable and was not being looked for. Two sources now are: the
service's **own** `.env.example` — which the root-level analyzer never sees, because in
this repository it lives in `backend/` — and `process.env.X` in the service's source.
With neither to go on, every known alias for that kind is supplied rather than one
guess: an unread variable costs nothing, and guessing wrong costs the entire run.

### Verified

- **The real repository now runs.** `Prompt-Engine` reaches `READY` with three
  containers — `mongo:7`, its backend on 5000, its frontend on 5173 — and its own output
  says so:

  ```
  [backend] ✅ MongoDB connected successfully
  [backend] ║ Database: Connected   Status: Ready ✅
  ```

- The `node-fullstack` fixture's backend now refuses to serve unless it actually reached
  its database, so a 200 from it proves the whole chain: provisioned, healthy, named,
  injected, connected.
- **Proven able to fail:** reverting to the rule's first environment key turns 4 unit
  tests red and takes the integration test from READY to FAILED; not waiting for the
  database does the same.
- 446 tests across three packages (443 passing, 3 skipped), zero residue — databases
  included, which is its own test.

### What is still missing

The browser. The page calls `http://localhost:5001`, the API is published on a random
host port, and a container alias is invisible to a browser — so the stack is healthy and
the UI still shows `Failed to fetch`. That is phase D, and it is now the only thing
between this repository and working.

## 2026-09-17 — Multi-service, phase B: run every service, together

Phase A described a repository as the set of things that have to run. This phase runs
them.

### What this phase adds

- **A plan per service, executed as one project.** `ProjectPlanner` reuses the 22
  detectors on each service directory — each one is an ordinary project in its own right
  — and adds only what a *set* needs: unique DNS names, and which service the session's
  URL points at.
- **A container per service, on the shared network.** Services reach each other by name:
  `http://backend:5000` resolves from inside the frontend's container.
- **Readiness belongs to the project.** It is `READY` only when every service that serves
  traffic is; a frontend that answers while its API is still starting is not something a
  person can use. A failure names the service it came from — "the project failed" is
  useless when four things are running.
- **Output stays readable.** Each service gets its own `LogManager`, so its sentinels
  stay its own, and lines are tagged `[backend]` / `[frontend]` into the session stream
  the socket protocol already carries.

A single-service repository is untouched: it takes the same path it always did.

### Two decisions worth recording

**No per-session network.** The obvious design, and wrong here: the egress policy is
keyed to `devlaunch-net`'s subnet (`172.31.250.0/24`), so a fresh network would come up
with no RFC1918 filtering and no block on reaching the VM host. Measured first — two
containers on `devlaunch-net` reach each other by alias, and the policy still applies —
so aliases on the existing network give name resolution at no cost to isolation.

**A service's declared port wins over the planner's default.** Alone, a service can be
told to listen anywhere: DevLaunch injects `PORT` and reads the mapping back. In a
project it cannot — siblings refer to it by name *and port*, and a frontend calling
`http://backend:5000` is broken by moving the backend to 3000. The repository's own
number is the only one everything else already agrees on. Found by a failing test, and
the fix needed the `PORT` environment variable changed in step with the plan: the
variable is what the application actually reads, so changing one without the other moves
the number DevLaunch watches while the service keeps binding the old one.

### Verified

- `node-fullstack` runs both services, each on its own declared port, and the web
  container reaches the api container by name. 5 integration tests against real Docker.
- **Proven able to fail:** dropping network aliases turns name resolution into
  `ENOTFOUND`; ignoring declared ports breaks the same test.
- **Against the real repository.** `Prompt-Engine` now plans as `project:web+api`, and
  both services start. Its frontend reaches `READY` on port 5173 — Vite's default, read
  from its own configuration. Its backend still fails, for exactly one remaining reason:

  ```
  [backend] ❌ MongoDB connection error: connect ECONNREFUSED 127.0.0.1:27017
  ```

  That is phase C.
- 441 tests across three packages (438 passing, 3 skipped), zero residue.

### Still to come

Databases are not provisioned (phase C), and a browser-hardcoded `http://localhost:5001`
still cannot be satisfied — container aliases are invisible to the browser, so the API
has to be published on the host port the page actually calls (phase D). The dashboard
still shows one pipeline and one URL for what is now several services (phase E).

## 2026-09-17 — Multi-service, phase A: see the whole project, not one folder of it

A real repository exposed the limitation this starts to close. `Prompt-Engine` reached
`READY`, its page rendered, and every request it made was refused:

```
GET  http://localhost:5001/api/history  → net::ERR_CONNECTION_REFUSED
POST http://localhost:5001/api/optimize → net::ERR_CONNECTION_REFUSED
```

The repository has `frontend/` and `backend/` and no root manifest. With nothing for the
detectors to match at the root, the AI fallback planned it — and picked
`workingDirectory: frontend`, silently ignoring the other half. DevLaunch did what it was
built to do: run *an* application. The project needed *its* applications.

Nothing was broken, which is the point. A tool that starts the UI and leaves its API
unstarted is indistinguishable, from the browser, from a tool that is broken.

### What this phase adds

`ServiceDiscovery` describes a repository as the set of things that have to run:

- **Every runnable directory**, at the root, one level down, and inside `apps/`,
  `packages/` and `services/`. A directory with no `dev` or `start` script is a library,
  not a service.
- **A role for each** — `web`, `api`, `worker`. Dependencies decide it, directory names
  only break ties: a folder called `server` that imports React is a server-rendered
  frontend, and the name is the weaker signal.
- **The port a service defaults to**, read from `process.env.PORT || 5000` and friends.
  Distinct from the port it will be *reached* on, which is what makes the difference
  decidable rather than a guess.
- **Absolute origins a `web` service hardcodes**, e.g. `http://localhost:5001`. These are
  resolved by the browser, so no container alias or internal network can satisfy them —
  the API has to be published on that exact host port or every request the page makes is
  refused.
- **Backing services the repository expects but does not contain** — MongoDB, Postgres,
  MySQL, Redis — from dependencies and from `.env.example` keys, recorded with the
  variable the application actually reads its connection string from.

A single-service repository reports none of this, so the existing path is untouched for
the case it already handles correctly.

- **Verified against the real repository.** Discovery of `Prompt-Engine` returns
  `web:frontend` calling `http://localhost:5001`, `api:backend` declaring port `5000` —
  the mismatch the repository actually ships — and `mongodb` via `MONGO_URI`.
- New fixture `node-fullstack` reproduces that shape without the network.
- 12 tests. **Proven able to fail:** looking only at the repository root turns 10 red;
  letting directory names beat dependencies turns 1 red; skipping the origin scan turns
  2 red.
- 436 tests across three packages (433 passing, 3 skipped), zero residue.

### Still to come

This phase only *describes*. Nothing runs differently yet: planning, execution, ports and
the dashboard all still assume one service. Those are the next phases.

## 2026-09-17 — Every package can run its own tests

Follows the pipeline-strip entry below. Tooling and test placement; no behaviour change.

### Why `pnpm add -D vitest` produced a broken install

Adding vitest to the frontend left `apps/frontend/node_modules/vitest` symlinked to
`node_modules/.pnpm/vitest@2.1.9/node_modules/vitest`, a directory pnpm never created,
and no `vitest` binary. Three installs, including `--force`, reported success and changed
nothing.

Two causes, and both had to be fixed:

1. **A missing optional peer.** vitest declares `@types/node` as an optional peer. The
   backend has it as a direct devDependency, so its vitest resolves to
   `2.1.9(@types/node@22.20.3)(lightningcss@1.32.0)` — a variant that exists in the store.
   The frontend did not, so pnpm resolved a bare `2.1.9` with no peers and then linked to
   a path it had no reason to materialise.
2. **Resolution was being skipped.** `Lockfile is up to date, resolution step is skipped`
   meant adding `@types/node` afterwards changed nothing: the stale bare entry was
   retained. `pnpm install --fix-lockfile` is what forces the re-derivation.

With `@types/node` declared and the lockfile re-derived, the frontend resolves to the
same variant as the backend and the binary links. The same two-line fix worked first time
on `packages/shared`, which is the check that this is the cause rather than a workaround
that happened to land.

### Tests now live in the package whose code they test

- `packages/shared` gains a runner, and `pipeline.test.ts` moves there from the backend
  suite — it tests `packages/shared/src/pipeline.ts`, and testing it from `apps/backend`
  was an artefact of that being the only place a runner worked. 20 tests.
- `apps/frontend` gains a runner and 8 component tests for `<PipelineStrip>`. Its `test`
  script no longer echoes and exits 0.

The component tests assert **rendered output**, not the projection function, because the
projection is already covered in shared and the remaining risk is the wiring between
them. That distinction is load-bearing: dropping the `furthest` prop in the component
leaves all 20 shared tests green and turns 3 frontend tests red.

No jsdom, deliberately. Every component here is a pure function of its props, so
`renderToStaticMarkup` exercises what a browser would paint; jsdom and
@testing-library/react would be dependencies simulating a document nothing touches. The
day a component needs to answer an event, `environment: 'jsdom'` is a one-line change.

- 424 tests across three packages (421 passing, 3 skipped), `pnpm -r test` exits 0.
- **Proven able to fail:** dropping the `furthest` prop turns 3 frontend tests red;
  removing the `repairing` badge turns 1 red.

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
- 20 tests added (suite 399 → 419). They lived in the backend suite at first because that
  was the only place a working vitest existed — resolved by the entry above, which gives
  `packages/shared` and `apps/frontend` runners of their own and moves these tests to the
  package whose code they test.

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
