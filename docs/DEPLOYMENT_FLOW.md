# Deployment flow

What happens between "here is a GitHub URL" and "here is a working application", in the
order it happens. Every step is recorded as an event on the deployment's timeline
(`GET /api/deployments/:id/events`), with its duration.

```
URL ─▶ validate ─▶ clone ─▶ analyse ─▶ plan ─▶ validate plan ─▶ [ask for configuration]
                                                                      │
        ┌─────────────────────────────────────────────────────────────┘
        ▼
   start databases ─▶ start services (install ▸ build ▸ start, per container)
        ▼
   wait for readiness ─▶ end-to-end check ─▶ READY
        │                        │
        └── failure ─▶ classify ─▶ repair (bounded) ─▶ retry ──┘
```

## 1. Validate the input — before anything exists

`https://github.com/owner/repo`, with or without `.git` or a trailing slash, or
`…/tree/<branch-or-tag>`. Anything else — another host, `ssh://`, `git@`, credentials in the
URL, a malformed ref — is refused with `400` and nothing is started. (`GitManager`)

## 2. Clone — `CLONING`

Depth 1, no submodules, no tags, LFS skipped, into a fresh directory of its own under the
system temp directory. Size, file-count and time limits apply while it runs. The commit that
was checked out is recorded and shown: every result says which code it is about.

## 3. Understand the repository — `ANALYZING`

Manifests, lockfiles, compose files, README, entry files and the source they import, at
the root, one folder down, and — when nothing runs there — inside the one folder that holds
the application:
frameworks, services (one or several), ports, the package manager and its exact install
command, the runtime version, databases, environment variables, cross-service calls, git
links to other repositories, imports that only work on a case-insensitive file system,
runtimes DevLaunch has no image for. (`RepositoryAnalyzer`, `ServiceDiscovery`)

## 4. Plan — `PLANNING`, `VALIDATING`

Deterministic rules first (`RuleBasedPlanner`, `ProjectPlanner`); a model only when no rule
matched and the repository is not known to be unrunnable (`AIPlanner`, optional). Every
plan — rule or model — passes the same validator: command allowlist, code-injecting
environment variables refused, paths inside the repository, approved images only.

## 5. Configuration — `AWAITING_INPUT` (blocked by user configuration)

Variables the repository needs and nothing can supply. Each is labelled: an outside
service's key, another secret, or a plain setting. Secrets an application only signs its own
sessions with (`JWT_SECRET`, `SECRET_KEY`…) are generated instead of asked for; database
addresses DevLaunch provisions are injected instead of asked for. Nothing is ever invented
for an outside service. Values the repository's `.env.example` ships are passed in, as
`cp .env.example .env` would — below everything DevLaunch sets, and never a `localhost` one.

## 6. Start — `STARTING`, then `WAITING_FOR_READY`

Databases first (Postgres, MySQL, MongoDB, Redis), on the protected network, each checked
with its own health command. Then one hardened container per service; the repository is
copied in and a fixed wrapper runs **install → build → start**, printing a marker at each
step. Those markers become `INSTALL_STARTED`, `INSTALL_SUCCESS`, `BUILD_*`, `START_STARTED`
events with durations. Within a deployment, a container restarted for a repair reuses the
packages an earlier one finished installing.

## 7. Ready — only on evidence

1. **Readiness**: the service's port answers an HTTP(S) request.
2. **End-to-end check** (`SmokeTest`): every service answers without a server error; every
   API address a frontend was given answers (from this machine, or from inside the
   frontend's container for an address its dev server resolves); every service can open a
   connection to every database started for it, from inside its own container.

All passed → `READY`. Something answered but a check failed → `PARTIALLY_READY`, with
`APPLICATION_UNHEALTHY` naming the failed check. Nothing answered → a classified failure.

## 8. When something fails

The failure is classified from the logs into a code with evidence (the exact line) and, from
one table, a category, whether retrying can help, and a next step (`FailureClassifier`,
`taxonomy.ts`). Then:

- **Out of memory** (decided by Docker's own flag): retried with more memory, up to what the
  machine can spare (`MemoryPolicy`). The amount that worked is remembered for the next run.
- **A known, safe fix exists** (`DeterministicRepair`): applied, with its evidence, and the
  service restarted. At most `DEVLAUNCH_MAX_REPAIR_ATTEMPTS` (2) plan repairs; a plan already
  tried is never tried again.
- **Otherwise**, a bounded model repair if configured, validated like any plan.
- **A crash a watcher would hide** (`[nodemon] app crashed`, `Unable to compile TypeScript`,
  `EADDRINUSE`) ends the wait at once instead of after the readiness budget.

Nothing retries forever: memory raises and plan repairs each have their own limit, and every
retry is recorded with its reason, attempt number, what changed and how it ended.

## 9. Running, stopping, cleaning up

A READY deployment is watched; a container that exits ends it as `APPLICATION_EXITED`.
`POST /api/deployments/:id/cancel` (or the dashboard's Stop) stops everything it started —
containers, databases, its workspace volumes — including anything that finished starting
after the stop. Idle and lifetime clocks reclaim forgotten deployments. At startup,
DevLaunch removes containers a crashed process left behind and marks their deployments
`interrupted by a DevLaunch restart`.

## States

`QUEUED → CLONING → ANALYZING → PLANNING → VALIDATING → [AWAITING_INPUT] → STARTING →
WAITING_FOR_READY → READY | PARTIALLY_READY`, with `REPAIRING` in between retries, and
`FAILED`, `CANCELLED`, `COMPLETED` (a program that ran and finished) as endings.
