# Limitations

Deliberate v1 boundaries, stated honestly. Each is a decision, not an oversight.

## Repository Dockerfiles are ignored

If a repository ships its own `Dockerfile`, DevLaunch does not use it. Building it
would execute arbitrary `RUN` instructions at build time — exactly the untrusted-code
execution the sandbox exists to prevent — and it would make the Run Plan meaningless,
since the Dockerfile would *be* the plan.

Consequence: repositories that only build correctly via their own Dockerfile will fail
or fall back to the AI planner.

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

## No database provisioning

Repositories requiring PostgreSQL, Redis, MySQL, or similar are detected and reported
as `DATABASE_REQUIRED`. V1 does not provision them, and does not support multi-container
Docker Compose.

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

## Readiness is not correctness

READY means an HTTP server accepted a connection and returned a complete response. It
does not mean the application works, that its routes behave, or that its data layer is
healthy. A configured health check status is surfaced as a hint, never as a gate.

Nor does it keep meaning anything. A READY session re-checks every five seconds that its
container is still alive, and ends as `APPLICATION_EXITED` when it is not — but that
check asks whether the process exists, not whether it still serves traffic. An
application that wedges without exiting, or starts returning 500s, stays READY.
