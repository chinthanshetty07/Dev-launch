# Limitations

Deliberate v1 boundaries, stated honestly. Each is a decision, not an oversight.

## Live DevLaunch processes

A DevLaunch server records itself in `~/.devlaunch/instances/` so another one starting does
not remove its running containers. The test suite's own runs do not register (only a
started server does), so a server started while the integration suite runs will remove the
suite's containers — the suite's runs, never a dashboard's. A crashed server whose process
id has been reused by another program is taken for alive until that program exits.

## A repository's own Docker setup is a fallback, not the first choice

DevLaunch runs a repository its own way when it can (its runner images, its plan, the
strict profile). Only when it cannot — a Go/Java/PHP/Rust/… project, or a layout no rule
reads — does it build and run the repository's Dockerfile or compose file, under the
balanced profile in `SECURITY.md`. Limits of that path:

- BuildKit-only Dockerfile syntax (`RUN --mount`, heredocs) does not build: the
  network-isolated builder is Docker's classic one.
- Compose settings that reach outside the sandbox are refused, not emulated; a setup that
  needs them must be run by hand.
- Compose `healthcheck`s, `profiles`, custom `networks` and `deploy` are not honoured;
  services start in `depends_on` order, a database once it accepts connections.
- An image's command is the repository's: no plan repair rewrites it; only a memory raise
  applies.
- A repository DevLaunch *can* partly run its own way is run its own way, even when a
  compose file describes more; the run says which compose services it does not start.
- Not applied, and said so: `.dockerignore` (the whole repository is sent to the build),
  compose override files, `depends_on: condition: service_completed_successfully` (a
  dependency is started first, not waited for to finish).
- Refused, by name: `ADD` from a URL, base images from non-public registries, and a compose
  image that is not on a public registry.
- With `DEVLAUNCH_MAX_CONCURRENT_DEPLOYMENTS` above 1, two compose runs share
  `devlaunch-net` under their compose service names, and DevLaunch's own MongoDB and Redis
  have no password: one run could reach the other's. At the default of 1, a replace now
  releases the old run before the new one starts.

## The container is the security boundary, not the planner

`npm run dev` executes whatever `scripts.dev` contains, and `package.json` is written
by the repository author. The command allowlist constrains what DevLaunch *composes*;
it does not and cannot constrain what the repository *does* once running.

Rule-based plans are not inherently safer than AI plans. Both derive from
attacker-controlled input. The isolation does the work.

## Network egress is open

Containers can reach the public internet, because `npm install` and `pip install`
require registry access. Restricting this meaningfully would need a MITM proxy with a
package allowlist, which is out of scope.

What *is* enforced, once `scripts/setup-network-policy.sh` has been run: RFC1918 and
169.254.0.0/16 are blocked, and so is the VM host itself, so a container cannot reach
the LAN, the cloud metadata endpoint, or anything listening on the Colima VM.

The rules live inside the Colima VM and do **not** survive recreating that VM. If the
network is absent the runner falls back to the default bridge and the security test
fails loudly rather than passing silently — but a run started that way has weaker
isolation than this document otherwise claims.

## ARM64 only

Development and testing target Apple Silicon via Colima. x86-only prebuilt binaries
are not emulated — qemu under Colima is slow enough to blow the execution timeouts.

Repositories depending on x86-only native modules fail with `ARCH_INCOMPATIBLE`.

## Workspaces install twice

A workspace installs once at its root — but each service is its own container, so that
root install happens once *per service*. Correct, and slower than it needs to be: two
services mean the whole dependency tree is built twice. Sharing it would mean sharing a
volume between containers, which is a larger change than the duplication costs.

## One session at a time

Concurrency is 1. The Colima VM is provisioned at 4 GB on an 8 GB host; a second
concurrent container risks OOM during dependency installation.

## No persistence

Sessions and logs live in memory. Restarting the backend loses all session state and
log history. This is correct for a single-user local tool and keeps SQLite out of the
dependency tree.

## Databases are provisioned; a database DevLaunch does not know is not

Postgres, MySQL, MongoDB and Redis are detected from the repository's own dependencies,
connection strings and compose file, started beside the application, and injected under
the variable names that repository actually reads. Anything outside that set is reported
as `DATABASE_REQUIRED` and is not a plan problem.

A compose file's *named* image is a preference rather than a promise: one that cannot
start under the sandbox profile falls back once to the image DevLaunch verifies, and
says so.

## Public GitHub repositories only

HTTPS on `github.com`. No `ssh://`, no other Git hosts, no private repositories, no
credentials. This deliberately keeps the threat model small.

## Log history is bounded

Capped at roughly 5 MB or 10,000 lines per session, whichever comes first. Verbose
builds will have their earliest output evicted; a truncation marker makes this visible
rather than silent.

## One session at a time

DevLaunch runs one session at a time, because the Colima VM cannot safely host more. A
launch refused for that reason names the session in the way and carries its id, the
dashboard offers to stop it, and `GET /api/sessions` lists everything this process knows
about. A session that never becomes ready releases the slot on its own after twice the
time-to-ready budget.

## One project at a time, per machine

Concurrency is one session per DevLaunch process, which says nothing about two processes.
Services share `devlaunch-net`, and Docker round-robins a duplicated network alias rather
than refusing it, so two projects that both contain a service called `backend` would
otherwise leave one project's frontend talking to the other's API. A bare name is claimed
only when nothing already answers to it; the loser keeps its session-scoped alias and is
told why.

## A frontend's API address may be a literal, and then it is reported

Where a repository reads its API base and its allowed browser origin from variables,
DevLaunch sets both: the frontend is told where the API was actually published, and the
API is told where the frontend is actually served. Which of the two addresses a variable
gets depends on who resolves it — a `VITE_`-prefixed name is inlined into the bundle and
read on your machine, so it gets the published port, while anything else a frontend reads
is read inside its own container, so it gets the container alias. A dev server's proxy
target is the second kind, and giving it the first is a frontend that serves a page and
cannot reach its API.

Where the address is a literal instead, nothing reaches it. `cors({ origin:
'http://localhost:5173' })` names the port Vite uses by default, and a run that could not
have that port is refused by CORS on every request the page makes — which, from the
browser, is indistinguishable from the API being down. These are detected by comparing
what the source names against what was actually published, and reported above the URL
with the file and both addresses. The project still reaches `READY`, because every
service genuinely is running.

## One broken service no longer takes the others with it

A project whose API will not start used to go straight to `FAILED` and teardown, removing
a frontend that had been serving for a minute for a reason that had nothing to do with it.
That is the ordinary shape of a real failure, not an edge case: one service has a broken
import or names a dependency that does not exist, and the rest are fine.

Such a run now ends in `PARTIALLY_READY`. The services that work keep their containers and
their URLs, the one that did not is named with its own diagnosis, and the session stays
alive — so it holds the slot, answers `restart`, and is reclaimed by the same idle and
lifetime clocks as any other running session. `restart <service>` is the intended next
step once the repository is fixed.

The failure is still reported, and reported first. Keeping what works is not the same as
pretending the run succeeded.

## A restart keeps what was installed, and nothing else carries over

Within one session, a restart — a repair, a memory retry, a person pressing restart —
reuses the packages an earlier attempt installed, when it would run the same install in
the same image and directory, and that install finished. Services that install one shared
workspace share it, so the second does not install it again. Measured:
`ejazahm3d/fullstack-turborepo-starter` went from 222 to 87 seconds, and remix's repair from
a full reinstall to 4 seconds.

What does not change: a session's *first* install of a repository is still the
repository's own work — downloading and building its dependencies — and on a large tree
that alone can take over a minute. Nothing is kept between sessions except the package
download cache.

## The container memory limit is ours, and a retry says so

`DEVLAUNCH_CONTAINER_MEMORY_MB` defaults to 1024 — right for one container at a time on a
4 GB VM with a database beside it, and simply too small for some real projects: a Next.js
dev build and a large workspace install are killed by it. A limit DevLaunch sets is not
the repository's failure, so a run killed by it is retried with more, by rule and never by
a model, which cannot change a container's `HostConfig` by writing a plan.

The retry climbs a ladder — by default doubling, `1024 → 2048 → 4096` on this machine's
5910 MB VM — and stops at whichever comes first: the ceiling (the VM less a 512 MB reserve
for itself, capped at 4096 per container), `DEVLAUNCH_MEMORY_RETRY_LIMIT` raises (2), or
what the VM has free beside the other containers of the run, counted at what they use.
The ceiling used to be half the VM; a workspace install needing 2.4–2.9 GB then fitted on
some runs and not others while gigabytes sat idle, and the user chose the free memory
instead. Each attempt is a clean container, each is
recorded, and the last is a structured `OUT_OF_MEMORY` naming every limit tried and the
maximum. A Node heap OOM is answered first with a larger heap (three quarters of the
container) and only then with a larger container. Memory raises have their own budget and
do not spend the two plan repairs.

"What the VM has free" is a ledger of the containers this process started, and it is checked
against Docker rather than trusted: a container Docker no longer has stops counting the
next time the ledger is asked. It was trusted once, and a run of dashboard stops left eight
holds behind with no container under any of them — a later run was refused memory with
"86 MB is free after the 8 other container(s)" beside an empty Docker. The ledger is per
process; a restart starts it empty.

A repository that needed more than the starting limit is remembered: the next run of it
starts at what it needed, never above the ceiling, and the log says so. One number per
repository and service, in `~/.devlaunch/memory-hints.json` (or `$DEVLAUNCH_STATE_DIR`),
readable only by its owner, at most 500 entries. Saved only after an attempt got past its
install with more than the starting limit.

The limit is one per container, and a container runs install, build and start. The phase
that ran out is recorded; a separate limit per phase would mean resizing a live container
between phases, which is not done. So a service raised for its install keeps that limit
while it serves.

At the ceiling it stops and reports honestly — give the VM more with
`colima stop && colima start --cpu 4 --memory 8`, or raise
`DEVLAUNCH_CONTAINER_MEMORY_CEILING_MB`.

## A backend running old code says so

Sessions and logs live in memory and the dev server is long-lived, which means it can
outlive the code it was started from. One ran here for five days while a fix landed
twenty-nine minutes after it started; every launch afterwards was planned and diagnosed
by the old version, with the same panels and the same confidence as a real failure.

`/api/health` now reports the commit the process started from and the commit the working
tree is on, and the dashboard shows a banner when they differ. Outside a git checkout it
says nothing at all: no repository is not evidence of staleness, and a banner that fires
every time is one nobody reads.

## Readiness is not correctness

READY means an HTTP server accepted a connection and returned a complete response. It
does not mean the application works, that its routes behave, or that its data layer is
healthy. A configured health check status is surfaced as a hint, never as a gate.

Nor does it keep meaning anything. A READY session re-checks every five seconds that its
container is still alive, and ends as `APPLICATION_EXITED` when it is not — but that
check asks whether the process exists, not whether it still serves traffic. An
application that wedges without exiting, or starts returning 500s, stays READY.

## A dev-server proxy pointing at localhost is reported, not fixed

A Vite or CRA dev server told to forward `/api` to `http://localhost:8000` resolves that
itself, inside the frontend's own container, where `localhost` is the frontend. No
environment variable or flag reaches a literal in a config file, and DevLaunch does not
edit a repository to make it run.

It is detected and named — the file, the target and the replacement — as a planning
warning before the run starts. The project still reaches `READY`, because every service
genuinely is running; the page's requests are what fail.

## A bind address written into the source cannot be overridden

`app.listen(port, 'localhost')` is not configuration. The analyzer finds it, the planner
warns about it before the run, and the failure names the line to change — but nothing
DevLaunch can do makes that application reachable through a Docker port mapping.

## Three runtime images, and no more

Node 20, Node 22 and Python 3.12. 20 is the default and 22 is chosen from evidence — a
`node:` built-in import, or an `engines.node` lower bound — so `WRONG_RUNTIME_VERSION` is
repairable by rule between them, and never by a model: no plan a model writes can conjure
an image the allowlist does not carry.

There is no Bun. A repository whose start script runs `bun` or `bunx` is declined before
anything is built, naming the script — rather than planned, failed on `bun: not found`,
and handed to a model to repair a runtime that is not there. A `bun.lock` alone is not
that: such repositories usually install and run under npm, and do.

Python has one version, so it has nowhere to move. A repository pinning a dependency with
no wheel for 3.12 — or importing `imp`, `distutils` or another module the standard library
removed — is reported at once rather than repaired.

## A submodule can need what its distribution does not install

`pip install sqlalchemy` installs no greenlet, and `sqlalchemy.ext.asyncio` does not work
without it — SQLAlchemy ships that support behind an `asyncio` extra. A repository
declaring plain `sqlalchemy` and importing the async engine therefore installs cleanly,
starts, passes readiness, and dies on its first query.

The import scan reduces every import to the name pip installs, which is right for
installing and loses exactly the evidence that matters here. It is kept separately now,
and the requirement is appended beside the manifest — never over it, so every version the
repository pinned still decides. The warning names the import rather than only the
package, so the judgement can be checked.

What gets installed is `greenlet` and not `sqlalchemy[asyncio]`, which would be the truer
expression of the intent. Commands run through `sh -c`, where `[` is a glob character,
and an argument whose expansion depends on what files a repository happens to contain is
not worth having; widening the command whitelist for it would trade a real boundary for
tidiness. The cost is that this drifts if the extra ever gains a second member.

The table has one entry. Each addition should be able to name the repository that proved
it — a guessed entry adds a download to every run that imports a popular package.

## Installing from imports is unpinned

A Python project with no requirements.txt or pyproject.toml is planned from what its
entry files import. The distributions are correct — they are what the source says it needs
— but nothing constrains their versions, because the repository constrained nothing. A
project written against an older major version of a library it does not pin will install
the current one and may fail in its own code. The plan says so in a warning.

## DevLaunch edits a repository only when told to, and only its own clone

`DEVLAUNCH_REWRITE_SOURCE` is off by default. With it off, a loopback address written
into a repository's source is *found and named* — the file, the line, the replacement —
and the run proceeds or fails as the repository dictates. That is always right and costs
nothing.

It does not, however, run the project. Two shapes cannot be run any other way, because
the address is a literal and no environment variable, flag or plan reaches it:

- a dev server proxying to `http://localhost:8000`, which it resolves inside its own
  container, where `localhost` is the frontend rather than the API beside it;
- a Python database URL hardcoded to `localhost`, which reads no variable at all.

With the flag on, those two literals are rewritten. The constraints are the point:

- **Only a clone.** A session launched from a `sourceDir` — a fixture, or a path someone
  supplied — runs against a directory that already existed, and that is somebody's
  working copy. Nothing is written there, flag or no flag. This was not a hypothetical:
  a live run rewrote this repository's own fixture before the check existed.
- **Only files analysis identified**, never a tree-wide search and replace.
- **Only the exact literal that was found**, once, and only if it is still present.
- **Only a loopback host.** A target already naming a reachable host is left alone.
- **Paths are resolved through `realpath`**, so a symlink in the repository cannot reach
  outside the clone.
- **Every edit is shown** — in the log, and in a panel above the plan and the output, with
  both sides of the change and the reason. Passwords are redacted from the log line,
  because a credential in the literal may be a real one its author pasted.

## A missing favicon is answered only where DevLaunch chose the server

Every browser asks for `/favicon.ico`, whether the page links one or not, and a repository
without one shows `favicon.ico: 404` in the console of a page that works. For a static site
the server is DevLaunch's choice, so DevLaunch answers it: its static server is Python's
`http.server` with a missing `/favicon.ico` answered `204 No Content`. A favicon the
repository has is served as it is, and every other missing file is still a 404. No icon is
invented.

For an application — Flask, Express, Next and the rest — the 404 is the application's own
answer, the same one it gives on the developer's machine, and DevLaunch leaves it alone.
Answering it would mean a proxy between the browser and every application, which changes
what the application's own URL is and is not done for a console message.

## HTTPS only where the repository serves it, and only for uvicorn

An application that refuses plain HTTP is served over TLS when its README starts uvicorn
with `--ssl-certfile` and `--ssl-keyfile` and both files are in the repository. The link is
then `https://`, and the browser warns once that the certificate is not trusted, because it
was made on the author's machine. Other servers that terminate TLS themselves (hypercorn,
gunicorn, a Node `https.createServer`) are not recognised yet. DevLaunch does not make
certificates of its own.
