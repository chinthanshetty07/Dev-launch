# Setup

## Requirements

- **Node ≥ 20** (developed on 24)
- **pnpm**
- **Docker via Colima.** Docker Desktop should work but is untested; the network policy
  script assumes `colima ssh`.

Development targets Apple Silicon. See [limitations](limitations.md) — v1 does not
emulate x86.

## Provision the VM

DevLaunch runs one container at a time with a 1 GB ceiling. On an 8 GB host:

```bash
colima start --cpu 4 --memory 4
```

4 GB is the practical maximum on an 8 GB machine — it leaves 4 GB for macOS. If Colima
is already running at a smaller size, `colima stop` first. **That stops every container
on the VM**, so do it when nothing else needs them.

## Install and build

```bash
pnpm install
pnpm build
```

`pnpm build` compiles the frontend. Without it the backend falls back to a plain harness
page rather than serving nothing.

## Build the runner images

```bash
./scripts/build-runner-images.sh
```

Builds `devlaunch/node:20` and `devlaunch/python:3.12`. These are DevLaunch's own images,
not stock upstream ones, for two reasons found by testing:

- `/workspace` must exist **and be owned by the non-root user**. An anonymous volume
  inherits ownership from the image path it shadows, so a volume over a missing path
  mounts root-owned and a non-root process cannot write to it.
- They ship a compiler toolchain, so packages without an arm64 wheel build from source
  instead of failing outright.

The Python image also puts `$HOME/.local/bin` on `PATH` — pip installs console scripts
(`flask`, `uvicorn`, `streamlit`) there when running non-root, and without it every
Python start command fails with exit 127.

## Install the network policy

```bash
./scripts/setup-network-policy.sh
```

Creates the `devlaunch-net` bridge and installs iptables rules inside the Colima VM,
blocking container egress to RFC1918, link-local, and the VM host itself, for every network
in `172.31.0.0/16` (each run gets one of its own from that range). Also creates the
`devlaunch-build` cgroup that caps a Dockerfile build at 2,048 processes and 4 GB, with a
boot service so it comes back after the VM restarts. Idempotent. `./devlaunch install`
runs it; `./devlaunch doctor` reports both.

**The rules live inside the VM and do not survive `colima delete`.** Re-run after
recreating it. If the policy network is absent the runner falls back to the default
bridge and the security suite fails loudly rather than passing with weaker isolation.

## Run it

```bash
pnpm serve
```

Open <http://localhost:3939>, paste a public GitHub URL (or pick a fixture) and press
**Launch Repository**.

### Frontend development

```bash
pnpm dev
```

Vite on port 5180, proxying `/api` and `/ws` to the backend on 3939 — so the browser
stays on one origin and there is no CORS surface to configure. Run `pnpm serve` alongside.

## Tests

```bash
pnpm test        # everything, including containers and one network clone
pnpm test:unit   # no Docker required
```

Integration tests drive **real containers** and are not parallelised — concurrency is 1
by design. `integration/clone.test.ts` reaches GitHub.

## Configuration

Everything is optional; defaults live in `apps/backend/src/config`.

| Variable | Default | Purpose |
|---|---|---|
| `DEVLAUNCH_CONTAINER_MEMORY_MB` | 1024 | Memory a container starts with |
| `DEVLAUNCH_CONTAINER_MEMORY_CEILING_MB` | the VM less the reserve, ≤ 4096 | The most one container may be raised to; the ledger decides how much of it is free |
| `DEVLAUNCH_MEMORY_RETRY_ENABLED` | true | Retry an out-of-memory kill with more memory |
| `DEVLAUNCH_MEMORY_RETRY_LIMIT` | 2 | Memory raises after the first attempt (0–5) |
| `DEVLAUNCH_MEMORY_STEP_MB` | (double) | A fixed increment instead of doubling (≥ 64) |
| `DEVLAUNCH_STATE_DIR` | `~/.devlaunch` | Where deployment records (`deployments/`) and `memory-hints.json` are kept |
| `DEVLAUNCH_MAX_CONCURRENT_DEPLOYMENTS` | 1 | Deployments at once (also read as `DEVLAUNCH_MAX_CONCURRENT_SESSIONS`). Raise only with a larger Docker VM |
| `DEVLAUNCH_ENV_FILE` | `.env` at the repository root | Another file to load settings from (the doctor and tests use it) |
| `DEVLAUNCH_MEMORY_RESERVE_MB` | 512 | VM memory never promised to containers |
| `DEVLAUNCH_CONTAINER_CPUS` | 2 | Per-container CPU limit |
| `DEVLAUNCH_CONTAINER_PIDS_LIMIT` | 256 | Fork-bomb ceiling |
| `DEVLAUNCH_NETWORK` | `devlaunch-net` | Network carrying the egress policy (builds, checks) |
| `DEVLAUNCH_NETWORK_POOL` | `172.31.0.0/16` | Range each run's own network comes from; must match the setup script's |
| `DEVLAUNCH_BUILD_CGROUP` | `devlaunch-build` | VM cgroup that caps Dockerfile builds |
| `DEVLAUNCH_BUILD_PIDS_MAX` | 2048 | Setup script only: the build process cap |
| `DEVLAUNCH_BUILD_MEMORY_MAX_MB` | 4096 | Setup script only: the build memory cap |
| `DEVLAUNCH_REPO_MAX_BYTES` | 500 MB | Clone size cap |
| `DEVLAUNCH_REPO_MAX_FILES` | 20000 | Clone file-count cap |
| `DEVLAUNCH_LOG_MAX_BYTES` | 5 MB | Log buffer cap (bytes first) |
| `DEVLAUNCH_TIMEOUT_TIME_TO_READY_MS` | 600000 | Clone → ready budget |
| `DEVLAUNCH_TIMEOUT_SESSION_IDLE_MS` | 1800000 | Idle timeout, starts at READY |
| `DEVLAUNCH_TIMEOUT_AWAITING_INPUT_MS` | 600000 | How long an unanswered gate holds the slot |
| `DEVLAUNCH_TIMEOUT_LIVENESS_MS` | 5000 | How often a READY session re-checks its container |
| `DEVLAUNCH_WORKER_GRACE_MS` | 5000 | How long a worker must stay up after starting to count as running |
| `DEVLAUNCH_BUILD_MEMORY_MB` | 2048 | Memory limit for building a repository's own Dockerfile |
| `DEVLAUNCH_ALLOWED_HOSTS` | (none) | Extra host names the API answers to, comma-separated, when DevLaunch is served under a name other than localhost |

## Troubleshooting

**`Runner image "devlaunch/node:20" is not built`** — run `./scripts/build-runner-images.sh`.
The runner images are local and never published, so a pull would fail with an opaque
registry error instead of the actual remedy.

**`No Docker socket found`** — Colima is not running. `colima start`.

**Security test fails on the egress policy** — run `./scripts/setup-network-policy.sh`.
It fails rather than skipping, deliberately: a run with weaker isolation than this
documentation claims should be visible.

**Install fails with `Killed` or exit 137** — the container hit its memory ceiling. Raise
`DEVLAUNCH_CONTAINER_MEMORY_MB`, and the VM's memory with it.
