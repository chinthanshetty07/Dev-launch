# Architecture

DevLaunch answers one question: *how should an unfamiliar software project be run, and
did it actually work?*

```
PLAN → EXECUTE → VERIFY → DIAGNOSE → REPAIR
```

The load-bearing idea is a separation of authority. Deterministic rules decide **how to
run** a project. A sandbox **executes**. A verifier **decides whether it worked**. A
language model is consulted only where the other three genuinely cannot help — and even
then its output is validated and sandboxed identically to everything else.

## Pipeline

```
GitHub URL
    │
    ▼
GitManager ──────────── shallow clone, bounded by size and file count
    │
    ▼
RepositoryAnalyzer ──── reads manifests, lockfiles, configs, .env.example
    │                   (describes; never decides)
    ▼
RuleBasedPlanner ────── 22 detectors → Run Plan, zero model calls
    │                        │
    │                        └── no match → AIProvider (opt-in; off without a key)
    ▼
RunPlanValidator ────── one gate, identical for every plan source
    │
    ▼
[AWAITING_INPUT] ────── required configuration, or which package to run
    │
    ▼
ExecutionManager ────── docker create → cp → start
    │                        │
    │                        ├── LogManager ──── demux, strip ANSI, ring buffer
    │                        └── ContainerSecurity ── non-root, read-only, capDrop ALL
    ▼
ReadinessChecker ────── HTTP poll with backoff; any response counts
    │
    ├── ready ────────── PortManager → host URL
    └── not ready ────── PortManager diagnoses *why*
                              │
                              ▼
                         FailureClassifier ── 13 signatures → cause + evidence + remedy
```

## Modules

| Module | Responsibility |
|---|---|
| `git/GitManager` | URL validation, bounded shallow clone |
| `analysis/RepositoryAnalyzer` | Reads a repository's own metadata |
| `planning/frameworks` | Detection tables, ordered most-specific-first |
| `planning/RuleBasedPlanner` | Metadata → Run Plan, deterministically |
| `planning/RunPlanValidator` | The single gate every plan passes |
| `security/CommandValidator` | Allowlisted binaries, no shell metacharacters |
| `security/ImageAllowlist` | Approved runner images, frozen at load |
| `security/PathValidator` | Rejects traversal, including post-normalisation |
| `docker/DockerManager` | Container lifecycle over the Docker API |
| `docker/ContainerSecurity` | Hardening flags, each asserted by a test |
| `docker/wrapper` | Static entrypoint script, env-driven |
| `execution/ExecutionManager` | Orchestrates launch, readiness, classification |
| `ports/PortManager` | Host mapping, and `/proc/net/tcp` introspection |
| `readiness/ReadinessChecker` | Bounded backoff polling |
| `failures/FailureClassifier` | Raw output → specific cause |
| `logs/LogBuffer` | Ring buffer capped by bytes, then lines |
| `logs/LogManager` | Stream demux, ANSI stripping, sequence numbers |
| `session/SessionManager` | Pipeline orchestration and lifetime |
| `cleanup/CleanupManager` | Idempotent teardown, orphan sweeping |
| `ai/AIProvider` | Fallback planning and bounded repair; opt-in, default refuses |

## Decisions that shaped the design

### The container is the security boundary, not the planner

`npm run dev` executes whatever `scripts.dev` contains, and `package.json` is written by
the repository author. The command allowlist constrains what **DevLaunch composes**; it
cannot constrain what the **repository does** once running.

Rule-based plans are therefore not inherently safer than AI plans — both derive from
attacker-controlled input. Isolation does the work, and the docs say so rather than
implying the deterministic path is trustworthy by nature.

### The wrapper is static, and commands travel by environment

The container entrypoint is byte-identical on every run. Commands arrive as `DL_*`
environment variables, assigned **last** so a plan-supplied variable cannot claim one of
those names and replace a validated command. That ordering is a security boundary, and
a test asserts it.

The start command is `exec`d so signals reach the application — which means the exit
code belongs to the app, not the wrapper. Phase sentinels printed to stdout supply the
missing half: exit code says *what*, sentinels say *where*.

### "Started" and "ready" are different facts

A container can run happily while the application inside never opens a socket. Readiness
means a server completed an HTTP response — **any** status. A 302 to `/login` and a 404
on `/` are both healthy servers; gating on 2xx would fail most real APIs.

### Diagnosis carries its evidence

Every failure classification names the log line that produced it and suggests a remedy.
Where no signature matches, the verdict is returned marked low-confidence rather than
invented. For a system whose argument is that the verifier decides rather than the
model, quietly guessing would undercut the whole thing.

### Ordering is load-bearing, twice

SvelteKit, Astro, Nuxt and Remix all depend on Vite. `ECONNREFUSED :5432` is also a
network error. In both the detector table and the signature table, a list walked in the
wrong order produces a confident, wrong answer — so both are ordered most-specific-first
and both have a test that fails if that ordering breaks.

## State machine

```
QUEUED → CLONING → ANALYZING → PLANNING → VALIDATING ─┬─→ AWAITING_INPUT ─┐
                                                       │                   │
                                                       ▼◄──────────────────┘
                                          BUILDING → STARTING → WAITING_FOR_READY
                                                       │
                                        ┌──────────────┼──────────────┐
                                        ▼              ▼              ▼
                                      READY        REPAIRING     CLEANING_UP
                                        │              │              │
                                        │              └──> (retry, max 2) ──┐
                                        │                                    │
                                        │              FAILED <──────────────┘
                                        │                            │
                                        └──────→ COMPLETED ◄─────────┘
                                                 CANCELLED
```

`AWAITING_INPUT` was absent from the original plan entirely. Both the configuration gate
and the monorepo picker need a "blocked on a person" state, and without one the only
alternatives are guessing or failing.

## Two clocks, deliberately

- **Time to ready** (~10 min): clone, install, build, start, readiness.
- **Session lifetime**, starting at READY: 30 min idle, 60 min hard cap.

The original plan had a single ~10 minute budget covering everything, which would have
killed a working application while someone was still using it.

A third bound covers `AWAITING_INPUT` (10 min). Concurrency is 1, so a session nobody
answers would otherwise hold the only slot until the process restarted.
