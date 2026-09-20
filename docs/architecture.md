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

## Projects, not applications

A repository is not one application. `frontend/` calling `backend/` is the ordinary shape
of a web project, and running one of them yields a page that loads and then fails every
request it makes — indistinguishable, from the browser, from a broken tool.

When discovery finds more than one runnable service, each is planned separately (the same
detectors, applied per directory) and run in its own container on the shared network,
where Docker's embedded DNS resolves one service's name from another. The session is
`READY` only when every service that serves traffic is.

Services share `devlaunch-net` rather than getting a network of their own, because the
egress policy is keyed to that network's subnet: a per-session network would come up
unfiltered. Aliases give name resolution without touching isolation.

## The compose file is a declaration, not an inference

Every other signal DevLaunch reads is inferred: a start script implies a command, a
dependency implies a database, a literal in source implies a port. A `docker-compose.yml`
is none of those. It is the author stating which services exist, where each one lives,
what it runs, which port it listens on and which database it needs.

Not reading it is what made complex repositories fail. Of three that failed here, two
shipped a compose file and the third a Makefile. One of those two keeps its code in
`app/backend` and `app/frontend`; discovery looked inside `apps/`, `packages/` and
`services/` — `app` singular was not on the list — found nothing, fell through to the AI
planner, and was handed `pip install -e .` at a repository root containing no Python
package. The compose file names both paths in full.

The lesson is not that the convention list was too short. It is that a convention is a
guess and a declaration is not, and lengthening the list would have produced the same
class of failure on the next repository that named its directories differently.

Compose supplies the map; convention-based discovery still supplies the detail, because
compose says nothing about a service's language, scripts or configuration variables.
Where they overlap the file wins. Two services built from one directory — the same image
started two ways — resolve to the one *without* a `command:` override, since an override
means the author is running something other than what the image is for.

It is read as evidence and never executed. DevLaunch still runs its own hardened
containers on its own network; `build:` contexts are read for their directory only.

An image named there is honoured only if it is a known variant of the kind already
detected — `pgvector/pgvector` for a Postgres, never an arbitrary name or another
registry. This matters both ways: a project using pgvector genuinely needs that image,
because plain `postgres` starts perfectly and then fails its first `CREATE EXTENSION
vector`; and the value comes out of a file in the repository, which is exactly the
attacker-controlled input the runtime allowlist exists to contain. An unrecognised name
is declined and the stock image used, which degrades to the previous behaviour rather
than to trust.

## Databases are provisioned, not assumed

A repository that declares `mongoose` needs MongoDB running before its backend starts —
applications connect at boot and get one chance. When discovery finds such a dependency,
the database is started first, waited on with the image's own health command, and its
connection string injected under the variable *that service* reads.

They are stock upstream images run as the unprivileged user the image already defines
(uid 999 for all four), which is what lets them keep the same hardening as the runner
images: their entrypoints only need to chown and switch user when started as root.

Data is in anonymous volumes and lasts exactly as long as the session.

This runs for **every** repository, not only multi-service ones. A lone API with a
database is the commonest shape there is, and while provisioning lived in the project
path those repositories got nothing: the analyzer detected Postgres, reported it, and the
run started anyway with no server and no connection string. What filled the gap was the
repair loop inventing `postgresql://user:pass@db:5432/dbname` and then spending its
remaining attempts installing drivers to satisfy a URL that could never have connected.

Dependencies are read from `requirements.txt` **and** `pyproject.toml`, because that is
how a database is detected. A packaged project — `pip install .`, PEP 621 metadata, no
requirements file — declared `asyncpg` and was seen to declare nothing at all: no
Postgres, no connection string, and an application falling back to its own `localhost`
default inside a container where nothing listens. It died in its startup hook with
`ConnectionRefusedError: [Errno 111]`, having never been told where its database was.

Only the four tables that can hold dependencies are read — PEP 621 `[project]`, its
optional extras, PEP 735 groups and Poetry's — rather than half-implementing TOML. Array
scanning tracks bracket depth outside quotes: `uvicorn[standard]>=0.30` is an ordinary
entry whose extras bracket, taken as the end of the list, hides every dependency after
it. In the repository that prompted this, that was the database driver.

Framework detection reads both manifests too. A packaged project declares fastapi only
in `pyproject.toml`; read from `requirements.txt` alone it declared nothing, planned as
nothing, and fell through to the AI planner. Its entry point lives inside the package —
`src/pg_rag/main.py` — where a scan of the working directory never looks, and it runs
only by its module path: `uvicorn pg_rag.main:app`, never `uvicorn src/pg_rag/main:app`.

A framework with no `start` or `dev` script is planned from its entry file — `main`
if it exists, else `app.js`, `server.js`, `index.js` and their `src/` forms. It is the
commonest shape of a tutorial repository, and `node app.js` is what its README says;
falling to the AI for it was a model call to read a filename, and the model left the
port and binding unknown.

A compose port below 1024 is never adopted for a dev server. `3000:80` describes nginx
serving a built bundle in the author's production image; DevLaunch runs `vite` instead,
and handing it `--port 80` is a permission error from a non-root process.

Tracking parameters on a pasted URL — `?utm_source=chatgpt.com` — are not identity. They
were ending up in the database name and the cache key.

The connection string names the driver the repository declared. SQLAlchemy encodes the
driver in the URL scheme, so a project depending on `asyncpg` and handed a plain
`postgresql://` loads psycopg2 and dies with *the asyncio extension requires an async
driver to be used* — against a database that is running, reachable and correct.

A value DevLaunch injects outranks one the plan carried, and is re-injected after every
repair. A repair rewrites the plan wholesale, so without that the retry is handed a
database it cannot find and the loop then diagnoses the absence it just caused.

## Package downloads outlive the container

Each repository gets a named cache volume mounted at `/cache`, which npm, pnpm and pip
are pointed at. The cache directory previously lived under `/workspace` — discarded with
the clone — so every repair re-downloaded the entire dependency tree from scratch. On a
LangChain-sized project that was measured at 13s cold against 5s warm, three times over,
which is most of what a live log shows while it appears to have stalled.

The volume is keyed on the repository rather than shared, because a cache is a writable
surface every container mounting it can see, and one repository's install has no business
writing anything another will later read. The mount point is created in the image owned
by the runtime user, because a fresh named volume inherits the ownership of the directory
it is mounted over — and a root-owned one leaves a non-root process unable to write a
single byte to its own cache.

## The browser is not on the container network

Services reach each other by name, but a page's `fetch` is resolved by the user's
machine. An API that a frontend hardcodes as `http://localhost:5001` is unreachable at
any other address, however correctly the project is orchestrated.

So host ports are chosen by DevLaunch before any container is created — preferring the
port a sibling hardcodes — and each service is told where the others are through the
variables it declares: the frontend's API base, the API's permitted origin. A preferred
port that is taken is reported, never silently substituted.

Both loopback stacks are checked when testing whether a port is free. `localhost`
resolves to `::1` first, so a port free on IPv4 and held on IPv6 will publish
successfully and send the browser to whatever already owns the address.

## Controls, and what a restart preserves

A service can be restarted on its own, or the whole project at once. It comes back on the
same host port with the same resolved plan — injected database URL and API base included
— because the port was written into its siblings' configuration and re-deriving the plan
would discard what was injected into it. The lifetime clock and liveness watch are
disarmed while containers are replaced, since both key off READY.

Resource use is sampled per container on request rather than streamed: a dashboard
polling every few seconds is the requirement, and Docker returns the previous CPU reading
alongside the current one, so one request is enough to compute a percentage.

## Two clocks, deliberately

- **Time to ready** (~10 min): clone, install, build, start, readiness.
- **Session lifetime**, starting at READY: 30 min idle, 60 min hard cap.

The original plan had a single ~10 minute budget covering everything, which would have
killed a working application while someone was still using it.

The handover between them has to be explicit. The time-to-ready budget is enforced by
stopping the container when it elapses, so a session that reaches READY **releases** it;
left armed it did exactly what splitting the clocks was meant to prevent — a ten-minute
ceiling on every session, with nothing in the logs to explain the death.

Once the lifetime clock owns the session, a **liveness check** every five seconds decides
whether the application is still there. Readiness was a measurement taken once, and an
application that has served a request can still crash a minute later; without the check
the session reported READY, and offered a URL that answered nothing, until the idle clock
expired. Only a definite answer ends it — an un-inspectable container is not evidence of a
dead application.

A third bound covers `AWAITING_INPUT` (10 min). Concurrency is 1, so a session nobody
answers would otherwise hold the only slot until the process restarted.
