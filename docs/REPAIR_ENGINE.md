# Repair engine

When a deployment fails, DevLaunch fixes what it can fix *safely*, tells you plainly what it
cannot, and never loops. This is the whole of what it repairs.

## How a repair is decided

```
failure ─▶ classify (code + the log line that proves it)
        ─▶ category, retryable, next step      (one table: packages/shared/src/taxonomy.ts)
        ─▶ is there a rule whose evidence is in the log?
              yes ─▶ change the plan ─▶ validate it ─▶ restart ─▶ check again
              no  ─▶ model repair, if configured (bounded, validated like any plan)
              no  ─▶ report, with the evidence and what to do
```

Every repair is recorded with: the failure it answered, what changed (before → after), the
evidence, and whether a rule or a model decided it. It appears in the dashboard, on the
deployment's timeline (`REPAIR_APPLIED`, `RESOURCE_RETRY`) and in its saved record.

## Limits — no infinite loops

- **Plan repairs:** at most `DEVLAUNCH_MAX_REPAIR_ATTEMPTS` (default 2) per service.
- **A plan already tried is never tried again**, whoever proposes it.
- **Memory retries** have their own budget (`DEVLAUNCH_MEMORY_RETRY_LIMIT`, default 2), and
  only follow an out-of-memory kill that Docker itself reported.
- A restart for a repair reuses the packages an earlier container finished installing, so a
  repair costs a restart, not a reinstall.

## What is repaired by rule

| When the log shows | DevLaunch | Example |
|---|---|---|
| Out-of-memory kill (Docker's `OOMKilled` flag) | retries with more memory: 1024 → 2048 → 4096 MB, never more than the VM can spare; remembers what worked | `wrrnlim/nextjs-docker-postgres-template` |
| V8 "heap out of memory" | raises Node's heap inside the same limit, then the limit | |
| A lockfile that disagrees with `package.json` (`npm ci` EUSAGE, `ERR_PNPM_OUTDATED_LOCKFILE`, Yarn `--frozen-lockfile` / `YN0028`) | installs without freezing the lockfile | `sveltejs/realworld` |
| The start script does not exist and another does | uses the one that exists | |
| ts-node refuses code with a type error | runs it with type checking off (`TS_NODE_TRANSPILE_ONLY`), once | `niksbanna/mern-boilerplate` |
| pip asked to build a project that is not a package | installs the declared dependencies with their version ranges instead | |
| `psycopg2` cannot build | installs `psycopg2-binary` | `testdrivenio/fastapi-crud-sync` |
| A package the application imports is missing, and the error names it | installs it | |
| A Python console script is not on `PATH` | runs the module instead (`python -m …`) | |
| The runtime is too old and a newer approved one exists | moves Node 20 → 22 | |
| The application opened a different port than planned | moves the plan to the port the kernel shows open | `ejazahm3d` (before port detection read `main.ts`) |
| The application listens on localhost only, through configuration | binds it to every interface | |
| A framework root that 404s by design | checks its known health path instead | |

## What is never repaired

- **The repository's code.** DevLaunch does not edit source to make a build pass. The one
  exception is opt-in (`DEVLAUNCH_REWRITE_SOURCE=1`), only in DevLaunch's own clone, and only
  for two literal addresses: a dev-server proxy and a hardcoded database URL pointing at
  `localhost`. Each edit is shown with both sides.
- **A runtime DevLaunch does not have** (an older Node, another Python, Java…): reported.
- **A missing secret** for an outside service: asked for, never invented.
- **A database DevLaunch does not provision** (RabbitMQ, Kafka…): reported.
- **A broken import or a case-only file name mismatch**: named, with the file and line.

## Code

`apps/backend/src/services/planning/DeterministicRepair.ts` (rules),
`services/execution/MemoryPolicy.ts` (memory), `services/failures/` (classification),
`services/ai/AIRepair.ts` (model, optional), `services/session/SessionManager.ts` (the loop).
