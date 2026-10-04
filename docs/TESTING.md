# Testing

```bash
./devlaunch test          # typecheck + every test that needs no Docker (~1 minute)
./devlaunch test --all    # adds the real-Docker tests (~10 minutes; Docker and the runner images required)
./devlaunch doctor        # is this machine ready
```

Run the Docker tests when the dashboard is idle: they start real containers in the same VM.

## Suites

| Suite | Where | Needs |
|---|---|---|
| Shared types and tables | `packages/shared/src/*.test.ts` | nothing |
| Dashboard components | `apps/frontend/src/**/*.test.tsx` | nothing |
| Backend unit tests | `apps/backend/src/__tests__/*.test.ts` | nothing (Docker is stood in for) |
| Real-Docker tests | `apps/backend/src/__tests__/integration/` | Docker, runner images, network |
| Readiness checks | `scripts/verify-readiness.sh` | a repository checkout |
| Real repositories | `scripts/corpus/run.mjs` | a running DevLaunch, the internet |

## Fixtures

`fixtures/` holds small, deterministic repositories, one per behaviour: each framework, a
monorepo, frontend + backend + database, a broken install, a wrong port, a missing variable,
a type error, an install that needs more memory, an HTTPS-only app, and more. They are the
controlled test matrix; `docs/fixtures.md` lists what each one proves. CI never depends on an
external repository.

## Real repositories

`scripts/corpus/corpus.json` lists 40 public repositories, pinned to commits. With DevLaunch
running:

```bash
node scripts/corpus/run.mjs --name <report-name>
node scripts/corpus/run.mjs --only owner/repo --name <report-name>
```

Each run writes `scripts/corpus/reports/<name>.{json,md}`: per repository, the commit, the
plan, every attempt and repair, the end state and the failure with its evidence. A report is
never overwritten without `--overwrite`.

## How a change is tested here

1. A test that fails on the old code, for every behaviour that changes.
2. The change.
3. **Mutation check:** the new code is broken on purpose, one way at a time, and the named
   test must fail each time. A mutation that survives means a missing test, which is then
   written.
4. A live run against the repository that showed the problem, when there is one.

A test that has to change because a fact changed is rewritten with a comment saying what
changed and why — never silently flipped to pass.
