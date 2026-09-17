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

**Phase 1 complete — minimal Docker runner.**

| | Phase | State |
|---|---|---|
| 1 | Minimal Docker runner | ✅ Complete |
| 2 | Security hardening | Not started |
| 3 | Port + readiness | Not started |
| 4 | Log streaming (WebSocket) | Not started |
| 5 | Repository analyzer | Not started |
| 6 | Rule-based plan generator | Not started |
| 7 | Failure classifier | Not started |
| 8 | AI fallback planner + repair | Stretch |
| 9 | Frontend | Not started |
| 10 | Documentation + portfolio | Not started |

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
pnpm typecheck
pnpm test          # includes integration tests that drive real containers
pnpm test:unit     # unit tests only, no Docker required
```

Integration tests pull `node:20-slim` on first run.

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

**The container is the security boundary, not the planner.** `npm run dev` executes
whatever `package.json` says, and that file is written by the repository author. The
command allowlist constrains what DevLaunch composes; isolation constrains what the
repository does.
