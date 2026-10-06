# Release report — production-readiness mission (2026-10-06)

Base commit `d4e4e60`; all changes uncommitted in the working tree at the time of writing.
Every figure below comes from a run made **after the last code change**, unless it says
otherwise. Pipeline: `.claude/tasks/2026-10-06-production-readiness-mission/`
(requirements, plan, audit findings, verifier report, reconciliation).

## 1. Verdict

**Release candidate for local use — with stated limits.** Every requirement R1–R15 has
recorded evidence; every critical and high finding is fixed with a test; two medium risks
on the new Docker path are not closable with Docker's classic builder and are documented
(§8). Not a candidate for hosting for other people (non-goal; see `HOSTING_PLAN.md`).

## 2. The kick-ass audit

The skill was found (`~/.claude/skills/kick-ass`) and its pipeline followed: requirements
(R1–R15) → one approval gate (the user added the Docker fallback; chose *fallback* and
*balanced*) → plan → implementation → three independent proofs → reconciliation →
changelog.

- **Adversarial audit** (fresh opus agent, read-only): 23 findings, 6 high. All addressed;
  table with proof in `DEVLAUNCH_AUDIT.md` §6. A-21 and A-22 are fixed without a test.
- **Independent verifier** (fresh opus agent): 14 defects (1 high: Docker daemon fetches
  outside the egress rules). 12 fixed with tests; D-2 and D-8 documented as not closed.
  `reconciliation.md` maps each.
- **Cold review** (mine): caught a misleading worker-failure message and a compose-worker
  port hazard.

## 3. Root causes fixed (the important ones)

| What went wrong | Why | Fix |
|---|---|---|
| Typed secrets and DB passwords sent to the model | the repair prompt serialised the whole plan | values hidden; hidden values restored from the model's answer |
| A clone's symlinks followed on the Mac | `stat` follows links; one lexical guard | outward links removed right after cloning |
| Project workers and post-READY crashes | workers READY with no check; liveness watched single services only | started-and-still-up check; every service watched |
| Stop/replace during a project start released nothing | containers lived only inside the launcher | run handed to the session at once; launcher halts between steps |
| DNS rebinding could drive the API | no Host/Origin check | `HostGuard` on HTTP and the log socket |
| Another DevLaunch (or the test suite) deleted a live dashboard's containers | startup swept every instance | live-instance registry |
| A model repair naming a missing file replaced the repository's diagnosis and leaked its DB | the refusal used the model-plan path | original diagnosis kept, run released |
| `index.html` beside a Go server served as a static site (false READY) | static rule ignored foreign runtimes | static rule declines; the Dockerfile runs it |
| Invalid `package.json` sent to the model | analyzer routed it to the fallback planner | `INVALID_MANIFEST` before anything runs |
| Docker daemon fetching outside the egress rules (`ADD <url>`, image pulls) | the daemon, not a build step, makes those fetches | refused / public registries only / pulls fresh |
| Three tests passing by luck | `until` helpers returned quietly on timeout | helpers fail on timeout; tests corrected |

## 4. New capability: a repository's own Docker setup (fallback)

Used only when no rule plans a repository. Built with Docker's classic builder on
`devlaunch-net` (BuildKit rejected: `buildx` makes its builder privileged; a rootless one
needs the VM's AppArmor relaxed). Run under the balanced profile; compose translated, never
run; dangerous keys refused by name. Measured breakout: from a build step and from the
running container, metadata, the Docker bridge, the VM and private ranges all BLOCKED;
package registries reachable.

## 5. Repository matrix

### Corpus — 40 public repositories, pinned (`scripts/corpus/reports/after7*.json`)

**29 of 40 READY** (after6: 30). The one-hour limit on a single background job split the run in two
(`after7`: 1–30; `after7b`: 31–40). Changes from after6:

- `danielfsousa/express-rest-boilerplate`: PASS → FAIL (PORT_NOT_LISTENING). Known flaky:
  its `dotenv-safe` refuses to start without `NODE_ENV`, and whether the model repair
  supplies it varies; it has flipped both ways across after5/after6/re-checks.
- `patelharsh9797/bun-hono-app`: UNSUPPORTED → PARTIALLY_READY via the Docker fallback —
  its Bun frontend serves; its API exits on its own environment validation (`ZodError`)
  because the compose file's `.env` is not in the repository.

Plan sources: 32 rule-based, 6 model, 1 Docker fallback, 1 none (refused before planning).
No repository that ran its own way took the Docker path (R15).

### Docker-path repositories (`scratchpad/matrix-final.txt`)

| Repository @ commit | Stack | Path | Result | Time | Left behind |
|---|---|---|---|---|---|
| GoogleCloudPlatform/cloud-run-hello @ dd23f50dc241 | Go | Dockerfile (PORT convention) | READY, check passed | 176 s | 0 |
| dstar55/docker-hello-world-spring-boot @ f231f3e7c1b4 | Java, Maven multi-stage | compose | READY, check passed | 31 s (cached) | 0 |
| bratzelk/spring-boot-hello-world @ 2e4bd2890909 | Java, needs a pre-built JAR | Dockerfile | BUILD_FAILED (honest: the JAR is not in the repository) | 3 s | 0 |
| rmuch/docker-php-hello-world @ 0d5839bda5e5 | PHP + Apache | Dockerfile (port from base image) | READY, check passed | 12 s | 0 |
| aiiddqd/php-simple-app @ 23239cfe8dec | PHP | compose | READY, check passed | 46 s | 0 |
| dockersamples/example-voting-app @ 63e9150ca17a | Python + Node + .NET + Redis + Postgres | DevLaunch's own (it can run `vote`) | READY for `vote`, with a warning naming `result` and `worker` as not started | 13 s | 0 |

Before the fixes this pass, `cloud-run-hello` was a **false READY** (served its Go template
as a static site) and the voting app's partial run carried no warning.

### Controlled fixtures (real Docker, `./devlaunch test --all`)

| Level | Fixtures | Result |
|---|---|---|
| 1–2 | static-site, node-http-basic, node-vite-app, python-flask-basic, python-django-basic, … | pass |
| 3 | node-fullstack, node-needs-database, python-async-postgres, project-backend-fails | pass (backend-fails: PARTIALLY_READY, backend named) |
| 4 | node-monorepo, node-workspace-one-app, docker-compose-stack, docker-go-api | pass |
| 5 | node-bad-manifest (INVALID_MANIFEST), node-port-conflict (PORT_NOT_LISTENING), node-install-network (dependency host named), node-install-oom (1024→2048 MB), node-dies-after-ready, node-never-listens, node-missing-env, docker-refused, docker-daemon-fetch, docker-breakout | each in its correct class, never READY where it must not be |

## 6. Test evidence (after the last code change)

| Check | Command | Result |
|---|---|---|
| Typecheck | `./devlaunch test --all` | clean (3 packages) |
| Backend unit + real Docker | same | **1,319 passed, 3 skipped, 0 failed** (98 files) |
| Frontend | same | 83 passed |
| Shared | same | 24 passed |
| Frontend build | `pnpm build` | built |
| Dependency scan | `pnpm audit` | 1 moderate (`uuid` via `dockerode`, unused functions); was 3 critical, 3 high |
| Mutation checks | break the fix, see its test fail | every behavioural change; survivors were equivalent mutations or are listed |
| Fresh copy | install, doctor, start (3940), deploy, status, logs, stop, clean | all as documented; deploy READY with check passed |
| Dashboard | in-app browser vs API | READY, PARTIALLY_READY, crash-after-READY without reload, plan source, hidden secrets |

Baseline before the work: 1,174 passed, **2 failed** (both from `7f14bb8`, fixed).

## 7. Repair reliability

Rules first (lockfile, start script, ts-node type check, psycopg2-binary, missing module,
console scripts, Node 20→22, port correction, bind address, framework health path); memory
raises bounded by the VM ledger (1024 → 2048 → ceiling; "needs more than is available"
reported with numbers, nothing retried — proven on real Docker); one model call per failure
class; a plan already tried is never retried; a model repair naming something impossible is
refused and the repository's own diagnosis kept. Not repaired: a repository's own image
(memory only), an invalid manifest, a missing secret, an unsupported runtime without a
Dockerfile.

## 8. Security

Fixed this pass: A-01, A-02, A-09, A-10, A-11, A-12, A-20, D-1, D-11, D-12. Proven by
`hostGuard`, `redaction`, `escapingLinks`, `dockerfileChecks`, `repoDockerRunner`,
`repoDockerSafety`, `integration/repoDocker`, `integration/security`, `ai`,
`deploymentRecords` tests.

**Outstanding, stated:**
- D-2: during a Dockerfile build step, no process limit and Docker's default capabilities
  (the classic builder accepts neither). A fork bomb can exhaust the VM until stopped.
- D-8: with concurrency above 1, compose service names and DevLaunch's MongoDB/Redis (no
  password) are not isolated between runs. Default concurrency is 1.
- No login: local use only, by design.

## 9. Checklist

| | |
|---|---|
| Builds and starts from a clean copy with documented commands | ✅ |
| Regression suite passes; pre-existing failures explained | ✅ |
| Simple-to-complex matrix exercised and recorded | ✅ |
| Supported project types detected and started | ✅ (29/40 corpus; Docker fallback for Go/Java/PHP/Bun) |
| Full-stack checked across frontend and backend | ✅ (end-to-end check, project liveness) |
| Accurate diagnostics | ✅ |
| Safe repairs verified by rerunning | ✅ |
| Memory escalation obeys real limits | ✅ |
| Readiness, cancel, restart, cleanup tested | ✅ (`lifecycle.test.ts`) |
| No unresolved critical/high defect | ✅ |
| No ignored critical security issue | ✅ (D-2 is medium, documented) |
| UI reports real state | ✅ |
| Docs state what works and what is limited | ✅ |

## 10. Remaining blockers

None for local use. For the Docker fallback's hardest edge, D-2 needs a different builder
(a rootless one, which needs the Colima VM's AppArmor user-namespace restriction lifted —
a decision for the machine's owner).

## 11. Run instructions

```bash
./devlaunch install
./devlaunch doctor
./devlaunch start                 # http://127.0.0.1:3939
./devlaunch deploy https://github.com/mdn/todo-react
./devlaunch test                  # typecheck + quick tests (~1 min)
./devlaunch test --all            # + real-Docker tests (~15 min, dashboard idle)
node scripts/corpus/run.mjs --name <name>   # the 40-repository corpus (~60 min)
```

## 12. Next action

Commit this work, then run the corpus nightly (a single job is limited to an hour; split as
`after7`/`after7b` were) so a change that breaks a real repository is caught the same day.
