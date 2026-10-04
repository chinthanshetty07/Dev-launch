# DevLaunch audit — 2026-10-04

An audit of DevLaunch against the production brief of 2026-10-04 ("GitHub URL → working
application"), done by reading the code, running it, and comparing both against the brief.
It is the implementation checklist: every finding has a status, and the status is updated
as work lands. Nothing here is marked fixed without a test that ran.

**Product goal, as adopted.** Automatically deploy *supported* application architectures,
detect unsupported cases and say so precisely, and repair common deterministic failures.
Not "any repository": a defined contract, measured by the corpus.

Severity: **CRITICAL** — reports success that is not true, or crosses the security
boundary. **HIGH** — a core requirement of the brief is missing, or a common repository
shape fails. **MEDIUM** — wrong or slow for some repositories, or hard to operate.
**LOW** — polish, or rare.

Status: ✅ fixed and tested · 🔶 partly · ⏳ not yet · 🚫 declined (reason given).

---

## 1. Current architecture

```
dashboard (React, Vite) ──HTTP /api, WS /ws──▶ backend (Express, Node 24, one process)
                                                  │
   SessionManager ── one session per run: state machine, repair loop, memory policy
     ├─ GitManager            shallow clone of a public github.com repo, size/time limits
     ├─ RepositoryAnalyzer    reads manifests, lockfiles, compose, README, entry files
     │    └─ ServiceDiscovery services, ports, env keys, databases, cross-service calls
     ├─ RuleBasedPlanner      deterministic plan per framework (Node, Python)
     ├─ ProjectPlanner        several services → one project plan, shared install
     ├─ AIPlanner / AIRepair  bounded model fallback (Groq), output validated like any plan
     ├─ RunPlanValidator      command allowlist, env denylist, paths, images
     ├─ BackingProvisioner    Postgres / MySQL / Mongo / Redis containers, readiness
     ├─ ExecutionManager      one hardened container per service, wrapper, readiness
     │    └─ ProjectExecutor  several services: ports, wiring, shared-install gate
     ├─ FailureClassifier     log signatures → typed failure with evidence
     ├─ DeterministicRepair   rule repairs with evidence; MemoryPolicy for OOM
     └─ CleanupManager        teardown, label sweeps, volume reaping
Docker (Colima VM, 4 CPU / 6 GB): devlaunch/node:20, node:22, python:3.12 + databases,
  on devlaunch-net (RFC1918 + metadata + VM host blocked)
```

**Data flow.** URL → normalise (https, github.com, no credentials, `/tree/<ref>`) → clone
(depth 1, no submodules, no tags, LFS skipped, size/file/time limits) → analyse → plan
(rules, else model) → validate → provision databases → launch containers (repository copied
in, static wrapper runs install → build → start, commands via `DL_*` env) → readiness →
watch → teardown.

**Lifecycle states.** `QUEUED CLONING ANALYZING PLANNING VALIDATING AWAITING_INPUT BUILDING
STARTING WAITING_FOR_READY READY PARTIALLY_READY REPAIRING CLEANING_UP FAILED CANCELLED
COMPLETED`. Kept as the public contract (§4 below maps the brief's pipeline onto them).

**Supported today (measured, corpus `after4`: 31 / 40 real repositories READY).**
Node: Vite, React (CRA), Next, Nuxt, Remix, Astro, SvelteKit/Svelte, Angular, Express,
Fastify, NestJS, plain `node`. Python: Flask (incl. app factories), FastAPI, Django,
Streamlit, Gradio, static sites. Package managers: npm, pnpm, Yarn 1/Berry (strict when
locked). Workspaces/monorepos: npm/pnpm/Yarn workspaces, Turborepo; several services per
project. Databases: Postgres, MySQL, MongoDB, Redis.

---

## 2. Findings

### 2.1 Correctness and "no fake success"

**A1 — CRITICAL — READY means "an HTTP server answered", nothing more.** ✅
*Why:* readiness was chosen as "accepted a connection and returned a response"
(limitations: "Readiness is not correctness"). *Effect:* a project whose frontend cannot
reach its API, or whose API cannot reach its database, is shown green. The brief's
definition of done requires the opposite. *Fix:* an end-to-end verification step after
readiness: every service URL answers without a 5xx; a frontend's wired API address is the
API's published address and answers from the host; every service that a database was
provisioned for can open a TCP connection to it from inside its own container. A failed
check turns `READY` into `PARTIALLY_READY` with `APPLICATION_UNHEALTHY` and the check that
failed as evidence. *Test:* unit tests per check; real-Docker test with an API that cannot
reach its database; a passing fullstack fixture still READY.

**A2 — HIGH — A start error that cannot recover still waits out the readiness budget.** ✅
*Why:* under nodemon (and similar watchers) a crashed app leaves its container running,
so readiness polls for minutes. *Effect:* `niksbanna/mern-boilerplate` spent ~50 s waiting
with `TSError` already in the log. *Fix:* while waiting, a log line matching a
*definitive* start-failure signature (TypeScript compile error, missing module, syntax
error, `EADDRINUSE`) ends the wait at once and is classified. *Test:* unit test with a
running-but-dead fake; real-Docker test with the type-error fixture under nodemon.

**A3 — MEDIUM — Case-only import mismatches pass on macOS and fail here.** ✅
*Why:* Linux file names are case-sensitive. *Effect:* `fakir-tech/typescript-fullstack-monorepo`
served a 500 for `./feedbackPanel` vs `FeedbackPanel.tsx`. *Fix:* the analyzer finds relative
imports whose target exists only with different case and warns before the run, naming the
file and line. *Test:* unit tests on a temp repository.

### 2.2 Failure classification and reporting

**B1 — HIGH — No failure category, retryability or suggested action.** ✅
*Why:* `FailureCode` is a flat list. *Effect:* the dashboard and API cannot say whether a
failure is the user's, the repository's, or DevLaunch's, or whether retrying can help.
*Fix:* one central classification table: every code gets a `category` (GIT, DETECTION,
RUNTIME, DEPENDENCY, INSTALL, OOM, BUILD, PORT, DATABASE, ENV, STARTUP, HEALTHCHECK, SMOKE,
REPAIR, SECURITY, TIMEOUT, USER_CONFIGURATION, UNSUPPORTED), `retryable`, `recoverable`
and a default `suggestedAction`, attached to every failure. Codes are unchanged. *Test:*
every code has an entry (exhaustiveness test); API responses carry them.

**B2 — MEDIUM — API errors come in three shapes.** ✅
*Fix:* one schema `{ error: { code, category, message, retryable, suggestedAction } }` on
the new `/api/deployments` routes; the old routes keep their shape for the dashboard.

### 2.3 State, identity, persistence

**C1 — HIGH — Nothing survives a backend restart.** ✅
*Why:* deliberate v1 decision ("No persistence"). *Effect:* after a restart nobody can say
what ran, at which commit, or why it failed; the startup sweep removes containers but the
record of them is lost. *Fix:* each deployment's record (id, repository, ref, commit,
services, ports, container ids, failure, repairs, attempts, events, timestamps) is written
to `~/.devlaunch/deployments/<id>.json` on every state change. On startup, a record left
in a non-terminal state is marked `FAILED` with `endedReason: interrupted by a backend
restart` after the sweep removed its containers. Records are listed by the API. *Test:*
unit tests on the store; a SessionManager test that a restart marks an interrupted record.

**C2 — MEDIUM — The commit being run is recorded but never shown.** ✅
*Fix:* deployment identity (id, repository, ref, commit) shown in the dashboard header and
returned by every deployment endpoint. The stale-backend check (`/api/health`
running vs head) already exists and is kept.

### 2.4 Observability

**D1 — HIGH — No structured, timestamped event log per deployment.** ✅
*Why:* logs are the containers' output plus prose lines. *Effect:* "what exactly went
wrong, and when?" needs reading prose. *Fix:* a per-deployment event timeline
(`{ at, event, phase, service?, severity, command?, exitCode?, durationMs?, attempt? }`) for
clone, detection, plan, install/build/start begin and end (from the wrapper's sentinels),
repairs, memory raises, readiness, verification and the final state; phase durations
derived from it. Secrets never enter it (commands only, never environment values).
Exposed at `GET /api/deployments/:id/events` and persisted. *Test:* unit tests on the
recorder; a session test that a run produces the expected sequence.

**D2 — MEDIUM — Logs only over WebSocket.** ✅ *Fix:* `GET /api/deployments/:id/logs`.

### 2.5 API

**E1 — MEDIUM — No deployment-shaped API.** ✅
*Fix:* `POST /api/deployments`, `GET /api/deployments`, `GET /:id`, `/:id/logs`,
`/:id/events`, `/:id/services`, `/:id/health`, `POST /:id/cancel`, `POST /:id/retry`,
`DELETE /:id`. Same engine; the session routes stay for the dashboard. *Test:* supertest-style
tests against the Express app with a fake engine.

### 2.6 Operations

**F1 — HIGH — No single command to check a machine or run the suite.** ✅
*Fix:* `./devlaunch doctor` (Node, pnpm, git, Docker reachable, Colima memory, runner
images, network policy, port 3939, disk, `.env` keys without printing values) and
`./devlaunch test | start | deploy | stop | status | clean`. *Test:* run on this machine;
doctor's checks unit-tested where pure.

**F2 — MEDIUM — README is a phase history, not a fresh-machine guide.** ✅
*Fix:* README rewritten around "clone → install → doctor → start → deploy"; the named docs
(`ARCHITECTURE`, `DEPLOYMENT_FLOW`, `SUPPORTED_STACKS`, `REPAIR_ENGINE`, `SECURITY`,
`TROUBLESHOOTING`, `TESTING`). *Test:* the fresh-machine run in §5.

**F3 — MEDIUM — Concurrency is hard-wired to one.** ✅
*Fix:* `DEVLAUNCH_MAX_CONCURRENT_DEPLOYMENTS` (default 1, because the 6 GB VM is the real
limit). Resources were already session-scoped (labels, volumes, aliases, memory ledger).
*Test:* two concurrent sessions with the limit at 2 do not share containers or volumes.

**F4 — HIGH — Settings in `.env` were silently ignored.** ✅
*Why:* `.env` was loaded inside `server.ts` after its imports had evaluated
`config/index.ts`, which reads every setting once, at import. *Effect:* timeouts, intake
limits, log caps and the concurrency limit set in `.env` did nothing; only the few
settings read at call time worked. *Fix:* `.env` is loaded by `loadEnv.ts`, the server's
first import. *Test:* a structural test that it is the first import, and a process test
that a value in a `.env` file reaches the config module.

### 2.7 Environment

**G1 — MEDIUM — Required variables are not classified.** ✅
*Fix:* each required variable gets a kind — `REQUIRED_SECRET` (KEY/SECRET/TOKEN/PASSWORD…),
`EXTERNAL_SERVICE_REQUIRED` (STRIPE_, OPENAI_, AWS_, SENDGRID_, TWILIO_…),
`REQUIRED_CONFIGURATION`, `AUTO_GENERATABLE_VALUE` (a database URL DevLaunch provisions, a
session secret it may generate), `OPTIONAL_CONFIGURATION` (has a default). The input
gate (`AWAITING_INPUT`, i.e. *blocked by user configuration*) shows the kind. No key is
ever invented. *Test:* unit tests on the classifier.

### 2.8 Security

What holds, verified by the existing security suite: non-root (1000:1000), read-only
rootfs, all capabilities dropped, `no-new-privileges`, memory/CPU/pids limits, tmpfs
`noexec`, no Docker socket, egress to RFC1918/metadata/VM host blocked, static wrapper with
commands via env and control variables assigned last, command allowlist, code-injecting env
denylist (`NODE_OPTIONS`, `LD_*`, `PYTHON*`…), path validation, size and time limits on
intake, API bound to loopback, DevLaunch's own secrets never passed to containers.

**H1 — MEDIUM — `TS_NODE_COMPILER` / `TS_NODE_TRANSPILER` are not denied.** ✅
*Why:* both make ts-node load a module by name before the app runs, like `NODE_OPTIONS`.
*Fix:* added to the denylist. *Test:* validator test.

**H2 — 🚫 declined — Building a repository's Dockerfile / running its compose file as is.**
A build runs the repository's `RUN` lines with Docker's default privileges on the default
network — outside DevLaunch's hardening and outside the egress policy that keeps a
container off the LAN and the metadata endpoint — and a compose file can ask for
`privileged`, host mounts and host networking. The brief asks for both isolation (§27) and
compose-as-is (§22); isolation wins. Compose is read as a *declaration* (services, images,
ports, env, depends_on), and every container still runs under DevLaunch's profile.
Revisit only with a build sandbox (rootless BuildKit on an isolated network).

**H3 — 🚫 declined for now — Private repositories.** Credentials would cross into a tool
that executes untrusted code; needs a token store and scoping first.

### 2.9 Coverage of stacks and services

**I1 — HIGH — Java, Go, Rust, PHP, Ruby, .NET are not supported.** 🔶
Each needs an approved runner image, a planner, install/build detection and fixtures. Not
started in this pass; detected and declined with a precise reason instead (✅): a
repository whose only manifest is `pom.xml`, `build.gradle`, `go.mod`, `Cargo.toml`,
`composer.json`, `Gemfile` or `*.csproj` is told which runtime it needs and that DevLaunch
has no image for it, without a model call.

**I2 — MEDIUM — Database migrations beyond Django are not run.** ⏳
Prisma `migrate deploy`, Alembic, Sequelize, TypeORM: detected-only is the next step.

**I3 — MEDIUM — RabbitMQ, Kafka, Elasticsearch, MinIO are not provisioned.** ⏳
Reported as `DATABASE_REQUIRED` with the service named.

**I4 — LOW — Browser-automation smoke tests (Playwright/Cypress) are not run.** ⏳

### 2.10 Already fixed earlier in this project (for the record)

OOM detection by Docker's flag and a bounded memory ladder; memory ledger checked against
Docker; package reuse between a session's containers; stop-during-start leak; dead-database
wait; NestJS port detection; project port flags; TypeScript compile repair; HTTPS apps;
generated requirements in any step; Flask factories; unsourced git links; npm evidence;
favicon on static sites; retry panel; memory hints per repository.

---

## 3. Decisions taken for this pass

1. **Containers only (Mode B is the only mode).** "Mode A, host execution" would run
   untrusted code on the user's machine. The brief's own §10 and §27 rule it out; every
   service runs in a hardened container. The runtime compatibility layer is the image
   choice (Node 20/22, Python 3.12).
2. **Compose is read, not executed** (H2).
3. **Verification changes READY.** A run that fails its smoke test is `PARTIALLY_READY`,
   not `READY`. The corpus will measure fewer READY runs where READY was not true.
4. **Persistence is files, not a database.** One JSON file per deployment, written
   atomically, readable by its owner only.
5. **The workspace stays under the system temp directory**, one random directory per
   deployment, removed at teardown; recorded in the deployment file. Moving it under
   `~/.devlaunch` gains nothing a temp directory does not already give, and a temp
   directory is cleared by the OS if DevLaunch is killed.

## 4. The brief's pipeline, mapped

| Brief | DevLaunch |
|---|---|
| VALIDATE_INPUT | `normaliseRepoUrl` / `splitRepoInput` before a session exists (400 on failure) |
| CLONE_REPOSITORY | `CLONING` |
| INSPECT … DETECT_ENVIRONMENT_REQUIREMENTS | `ANALYZING` |
| GENERATE_DEPLOYMENT_PLAN | `PLANNING` |
| VALIDATE_PLAN | `VALIDATING` |
| (missing configuration) | `AWAITING_INPUT` (= blocked by user configuration) |
| PREPARE_ENVIRONMENT, START_DEPENDENCIES | `STARTING` (databases first) |
| INSTALL_DEPENDENCIES, BUILD, START_APPLICATION_SERVICES | `STARTING` → wrapper sentinels, recorded as events |
| WAIT_FOR_READINESS, HEALTH_CHECK | `WAITING_FOR_READY` |
| END_TO_END_SMOKE_TEST | verification (events `VERIFY_*`) |
| DEPLOYMENT_SUCCESS | `READY` (only after verification passes) |
| FAILURE → CLASSIFY → REPAIR → RETRY | `REPAIRING`, bounded: 2 plan repairs + the memory ladder |

## 5. Verification log

What ran, where, and what it showed. Machine: Apple Silicon Mac, 8 GB; Colima VM 4 CPU /
5.8 GB; Docker 29.5.2; Node 24.21.

- **Every change** was tested the same way: a test that fails on the old code, then the
  change, then a mutation check — the new code broken on purpose one way at a time, each
  break caught by a named test. 43 mutations in this pass; every one is caught, after four
  gaps they exposed were closed with new tests.
- **Real Docker:** the end-to-end check on `node-fullstack` (frontend + API + MongoDB, Node)
  and `python-async-postgres` (Python), with every check run from inside the containers;
  the in-container connection check reporting a missing host in both images; two
  deployments at once sharing nothing and stopping independently; a nodemon crash ending the
  wait in 18 s instead of the readiness budget.
- **Fresh-machine run** (a clean copy of the project — no `.env`, no `node_modules` —
  following only the README): `./devlaunch install`, `doctor`, `start`, `deploy
  https://github.com/mdn/todo-react` → READY in 50 s with the end-to-end check passed;
  `status`, `logs`, `stop`, restart (the record survived), `clean` (refused while running,
  then ran). Caveat: Homebrew, Colima, Docker and the image cache were this machine's, not
  fresh. Two problems it found were fixed: a misleading network-setup message and a
  wrong phase-duration attribution.
- **Real repositories** — `scripts/corpus/reports/after5.md`, 40 public repositories pinned
  to commits: **30 READY**, every one of them after passing its end-to-end check
  (32 "answers" checks and 8 "reaches its database" checks, read back from the saved
  records). No run that answered was downgraded by the check. The 10 that did not reach
  READY: 8 outside the contract (Bun ×2, runtime too new for webpack 4, Angular bundling a
  git submodule, a Python dependency with no 3.12 wheel ×2, an Nx workspace needing .NET, a
  cookiecutter template), 2 the repository's own (a generator CLI that exits; a demo needing
  a `.env` it does not ship). The run met a failing network for a stretch; the three
  affected repositories were re-run alone and two returned to their previous results.
  Honest gap: the "frontend's API address answers" check did not fire on any of the 40 —
  none wired an API address into a frontend variable — so it is proven on fixtures only.
- **Changed since after4:** JayBhatt passes by rule; the Poetry cookiecutter template no
  longer passes (its earlier pass was a model's lucky guess; recognising templates is a
  candidate).
