# Changelog

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
