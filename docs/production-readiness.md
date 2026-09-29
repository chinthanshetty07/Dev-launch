# Production-readiness verification

**Date:** 2026-09-28 · **Commit:** `4d4b434` · **Verdict: ready for what it is, after F1.**

> **Update, 2026-09-29.** F1–F8 have since been closed or partially closed. Each heading
> below carries its status and the change that closed it. The findings are kept in full
> rather than deleted, because the reasoning is the part worth keeping, and a closed
> finding with no record of what it was is not evidence that it was fixed.
> `STRICT=1 ./scripts/verify-readiness.sh` now exits 0; it exited 1 when this was written.

DevLaunch is a **single-user local developer tool**, and this report judges it as one —
that framing was confirmed before any check ran. Every finding below names the command
that produced it and shows the output. Where a claim is backed by source rather than a
runtime observation, it says so in the claim.

Requirements, plan and the adversarial verifier's report:
`.claude/tasks/2026-09-28-production-readiness/`.

> **This is the second draft.** An independent verifier with fresh context found nine
> claims asserted without evidence, a smoke test that never exercised the path it claimed
> to, an arithmetic error, and one real finding missed entirely (F4, cache volumes). Each
> is corrected below. The first draft's failures are listed in `CHANGELOG.md` rather than
> hidden, because a verification report that cannot admit its own misses is not evidence
> of anything.

---

## 0. Premises in the brief that do not hold

| Assumed | Actual | Command and output |
|---|---|---|
| "The project uses Docker/Compose for all services" | No compose file, no Dockerfile for itself. `docker/` holds only the two *runner* images built for other people's repositories. | `ls docker-compose.yml compose.yaml Dockerfile` → `No such file` ×3<br>`find docker -type f` → `docker/runner/node.Dockerfile`, `docker/runner/python312.Dockerfile` |
| Ubuntu 22.04, Docker 24.x | macOS aarch64, Colima 4 CPU / 6 GiB, **Docker 29.5.2**, Node v24.21.0 | `docker version --format '{{.Server.Version}}'` → `29.5.2`<br>`uname -srm` → `Darwin 25.6.0 arm64` |

There is nothing to `docker compose up -d`. For a laptop tool that is correct, not a gap.

---

## 1. Test execution summary

### Automated suites

Baseline taken before any verification step.

| Suite | Command | Observed | Pre-existing failures |
|---|---|---|---|
| Backend, full | `vitest run` | `Test Files 37 passed (37)` · `Tests 814 passed \| 3 skipped (817)` | none |
| Backend, unit | `vitest run --exclude '**/integration/**'` | `Test Files 24 passed (24)` · `Tests 727 passed (727)` | none |
| Frontend | `vitest run` | `Test Files 10 passed (10)` · `Tests 63 passed (63)` | none |
| Typecheck | `tsc --noEmit` × 3 packages | no output, exit 0 | none |

**The 3 skips are all of `integration/groqLive.test.ts`** — identified via
`vitest run --reporter=json`:

```
SKIPPED: groqLive.test.ts :: plans an unrecognised repository, and the result survives validation
SKIPPED: groqLive.test.ts :: proposes a different plan when asked to repair one
SKIPPED: groqLive.test.ts :: never lets an unsafe repair through, whatever the model proposes
```

They need a live Groq key and are skipped without one. **This matters more than a skip
usually does:** the AI path is the one that takes untrusted repository content and
produces a plan that then gets executed. "814 passed" conceals that it was not exercised.
See F6.

### Smoke — the primary workflow, end to end

A **repository URL**, not a fixture. The fixture branch (`api/app.ts:182-199`) uses
`sourceDir` and never touches cloning or intake validation, so it cannot demonstrate the
workflow the brief names.

```
POST /api/sessions {"repoUrl":"https://github.com/pj8912/todo-app"}
  → 201 {"id":"fea4859c-53a3-46fe-b46e-3e5e9b5ce5e8","state":"CLONING"}
  … READY  http://localhost:32873/

curl http://localhost:32873/
  HTTP 200  bytes=323
  <form action="/addTask" method="GET">
    <input type="text" name="task" placeholder="Task">
    <button type="submit">Add

POST /api/sessions/:id/cancel
docker ps -a --filter label=com.devlaunch.managed -q | wc -l   → 0
```

**Pass.** Clone, analyse, plan, run, serve, tear down — a real repository, a real page.

### Integration — intake validation

`for u in …; do curl -XPOST localhost:3939/api/sessions -d "{\"repoUrl\":\"$u\"}"; done`,
then `GET /api/sessions/:id` for each. Messages **verbatim**:

| Input | Observed failure |
|---|---|
| `https://gitlab.com/a/b` | `UNSUPPORTED_PROJECT: Only github.com is supported, got "gitlab.com".` |
| `https://user:pw@github.com/a/b` | `UNSUPPORTED_PROJECT: URLs carrying credentials are rejected. Only public reposito…` (truncated by the reader at 60 chars, not by the message) |
| `http://github.com/a/b` | `UNSUPPORTED_PROJECT: Only https:// is supported, got "http:".` |
| `git@github.com:a/b.git` | `UNSUPPORTED_PROJECT: SSH-style URLs are not supported. Use a public https:// URL.` |

All four **rejected correctly** — but each was accepted with `201` first. See F3.

### Request size

```
python3 -c "print('{\"repoUrl\":\"https://github.com/a/' + 'x'*70000 + '\"}')" > /tmp/big.json
curl -XPOST localhost:3939/api/sessions --data-binary @/tmp/big.json
  → HTTP 413                                   (payload 70036 bytes)
```

### Performance

From the 28-repository sweep run earlier today. Raw log:
`scratchpad/sweep/full2.txt`; harness `scratchpad/sweep/run.mjs`.

```
15 READY · 2 PARTIALLY_READY · 10 FAILED · 1 AWAITING_INPUT  = 28
14m54s total · fastest 5s · slowest 158s · 1 model call across all 28
```

The 10 failures are each the repository's own (hardcoded loopback bind, Python 3.12
incompatible pins, a broken relative import, a package absent from PyPI, an arm64 native
build). Warm package caches bring a repeat run to 6–12s per repository.

---

## 2. Issue report

Severity bands: **CRITICAL** (unauthenticated remote code execution), **HIGH**,
**MEDIUM**, **LOW**. Graded for a local single-user tool; where that framing is what
makes something minor, it says so.

### F1 — CRITICAL — ✅ **CLOSED 2026-09-29** — The API binds every interface, and so does the log socket

> **Closed by** `bindHost()` in `server.ts`, defaulting to `127.0.0.1`; `DEVLAUNCH_HOST`
> widens it and startup warns when it is wider. Observed after the change:
> `TCP 127.0.0.1:3939 (LISTEN)`, `curl http://192.168.0.2:3939/api/health` → connection
> refused, `curl localhost:3939/api/health` → 200. The log socket shares the listener, so
> it is covered by the same change. Deliberately **not** in `config/index.ts`: that module
> is evaluated before `loadDotEnv()`, so a value read there would honour an exported
> variable and silently ignore the same line in `.env`.

DevLaunch has no authentication. For a local tool that is defensible — *if* it is
reachable only from the machine it runs on. It is not:

```
lsof -nP -iTCP:3939 -sTCP:LISTEN
  node  87364  cs  18u  IPv6  TCP *:3939 (LISTEN)        ← * , not 127.0.0.1

curl -o /dev/null -w '%{http_code}' http://192.168.0.2:3939/api/health
  200                                                     ← answered across the LAN
```

`POST /api/sessions` clones a URL and executes its contents. Anyone sharing a network can
therefore run arbitrary code in a container on this machine.

**The log WebSocket is on the same listener and has no origin check either**:

```
grep -cE "origin|verifyClient|Origin" apps/backend/src/websocket/LogSocketServer.ts
  0
```

So the exposure is not only execution: anyone on the LAN can also stream the live output
of whatever you are running, including anything a repository prints.

Graded CRITICAL rather than HIGH because it is unauthenticated remote code execution,
reachable right now, confirmed over the LAN by two independent checks. The container is
genuinely well confined (§ "Verified sound"), but confinement is defence in depth, not a
reason to be reachable.

**Reproduce:** from another machine on the LAN,
`curl -XPOST http://<host-ip>:3939/api/sessions -H 'content-type: application/json' -d '{"repoUrl":"https://github.com/<anything>"}'`

**Cause:** `apps/backend/src/server.ts:117` — `http.listen(port, r)`, no host argument.
Node then binds `::`. `LogSocketServer.attach(server)` (`server.ts:118-119`) shares it.

**Remediation:** bind loopback by default and make anything wider deliberate. Add a
`server.host` entry to `apps/backend/src/config/index.ts` (it does not exist today),
defaulting to `process.env.DEVLAUNCH_HOST ?? '127.0.0.1'`, and pass it:
`http.listen(port, config.server.host, r)`. If a wider bind is ever wanted, that is the
moment to require a token — and the WebSocket needs the same gate.

### F2 — HIGH — ✅ **CLOSED 2026-09-29** — Untrusted repository content reaches a model whose output is executed

> **Closed by** `__tests__/aiBoundary.test.ts`: a stub provider returns exactly what a
> successfully-injected model would, and every unsafe shape is refused — a piped shell
> command, `rm -rf /`, a binary off the allowlist, a working directory outside the repo,
> and a plan claiming to be `rule-based`. One test asserts an ordinary plan still passes,
> so the gate cannot be satisfied by refusing everything. No key, no network.

Not observed as an exploit; named because a production review of a tool that runs
arbitrary code must name it.

`apps/backend/src/services/ai/prompts.ts` builds a prompt from repository-controlled
material — README excerpt, script names, file listings — and `AIPlanner`/`AIRepair` turn
the response into a Run Plan. A repository can therefore attempt to influence the plan
that gets executed on the host's behalf.

Three things already blunt it, all verified elsewhere in this report: every plan passes
`RunPlanValidator` and the command allowlist regardless of origin; the plan runs in the
confined container; and the fallback planner is off without a key. What is missing is any
*test* that an adversarial README cannot steer a plan — and the three tests that exercise
the model path at all are the skipped ones (F6).

**Reproduce:** not attempted. Would require a fixture whose README instructs the planner.

**Remediation:** add a fixture repository carrying prompt-injection text in its README
and assert the produced plan is unchanged; run it in the suite, not only against a live
key.

### F3 — MEDIUM — ✅ **CLOSED 2026-09-29** — A rejected URL still gets `201 Created` and burns the session slot

> **Closed by** calling `normaliseRepoUrl` in the route, before the concurrency check.
> Observed: `POST {"repoUrl":"https://gitlab.com/a/b"}` →
> `400 {"error":"Only github.com is supported, got \"gitlab.com\".","code":"UNSUPPORTED_PROJECT"}`,
> and `sessions.list()` unchanged.

The HTTP layer performs no intake validation: `api/app.ts:167-179` passes `body.repoUrl`
straight to `sessions.launch()`. Rejection happens asynchronously inside the pipeline.

```
POST /api/sessions {"repoUrl":"https://gitlab.com/a/b"}
  → 201 {"id":"961b5cbe-360f-464b-83ab-42ede9534ed6","state":"CLONING"}

GET /api/sessions/961b5cbe-…
  {"state":"FAILED","failure":{"code":"UNSUPPORTED_PROJECT",
   "message":"Only github.com is supported, got \"gitlab.com\"."}}
```

A client cannot tell "accepted" from "will fail in a second", and with `maxSessions: 1`
each rejected URL occupies the only slot until it finishes failing.

**Remediation:** run the existing `GitManager` URL validation synchronously in the route
and return 400 with the message it already produces. Only the timing is wrong.

### F4 — MEDIUM — ✅ **CLOSED 2026-09-29** — Cache volumes are never reaped

> **Closed by** `CleanupManager.sweepStaleCaches`, run at startup beside the existing
> orphan-container sweep. Volumes older than `DEVLAUNCH_CACHE_MAX_AGE_DAYS` (14) that
> carry DevLaunch's own cache label are removed; a volume still in use is skipped rather
> than aborting the sweep. The existing 99 volumes are not deleted retroactively — they
> age out. Reclaim them now with `docker volume prune --filter label=com.devlaunch.cache`.

**Missed in the first draft of this report; found by the independent verifier.**

Teardown removes containers. It does not remove the per-repository cache volumes, and
nothing else does either:

```
docker volume ls -q | grep -c devlaunch      → 99
docker system df
  TYPE            TOTAL  ACTIVE  SIZE     RECLAIMABLE
  Local Volumes   106    1       5.116GB  5.032GB (98%)
```

One of those 99 was created by this report's own smoke test. On a tool whose job is to
clone arbitrary repositories, this grows without bound — 5 GB already, on a 100 GB VM
disk. There is also a second-order concern: the cache is a writable surface keyed per
repository and shared across runs of it (`ContainerSecurity.ts:83-109`), so anything a
repository writes there persists into its next run.

**Reproduce:** `docker volume ls -q | grep devlaunch | wc -l` before and after a session.

**Remediation:** reap volumes older than *n* days on startup, alongside the existing
orphan-container sweep in `CleanupManager.sweepAllOrphans`; or cap total cache size.
Document whichever, because unbounded disk is currently undocumented.

### F5 — MEDIUM — ✅ **CLOSED 2026-09-29** — The egress policy does not survive a VM restart

> **Closed by** `EgressProbe`: after the port is listening, one throwaway container on
> `devlaunch-net` tries to reach 169.254.169.254. Reaching it proves the policy is absent,
> and startup warns. Checked by behaviour rather than by reading iptables, because the
> rules live inside the VM and the backend runs on the host. Observed live:
> `/api/health` → `"egress":"enforced"`, no container left behind.

`docs/limitations.md` says the iptables rules "do not survive recreating that VM". They
also do not survive **restarting** it, which is far more common. Observed today after
`colima stop && colima start --cpu 4 --memory 6`:

```
colima ssh -- sudo iptables -S DOCKER-USER
  -N DOCKER-USER                                ← chain present, no rules

# after ./scripts/setup-network-policy.sh
colima ssh -- sudo iptables -S DOCKER-USER
  -N DOCKER-USER
  -A DOCKER-USER -s 172.31.250.0/24 -j DEVLAUNCH
```

Between those two states containers ran with the weaker isolation the docs warn about,
**silently**. That silence is the defect.

**Remediation:** check the chain at startup and refuse, or warn loudly, when it is
missing. Correct the doc's wording either way.

### F6 — MEDIUM — ✅ **CLOSED 2026-09-29** — The AI path is never exercised by the suite

> **Closed by** the same offline tests as F2. The three `groqLive.test.ts` tests still
> skip without a key — they exercise a live model, which is a different thing — but the
> path that turns model output into an executed plan is now covered with no network.

The three `groqLive.test.ts` tests are skipped without a key, and they are the only
coverage of the component that turns untrusted input into an executed plan. A green
"814 passed" reads as full coverage and is not.

**Reproduce:** `vitest run --reporter=json` and filter for skipped, as above.

**Remediation:** either run them in CI with a key held as a secret, or add offline tests
with a recorded/stubbed model response so the validation path is covered without network.

### F7 — LOW — ✅ **CLOSED 2026-09-29** — No CI of any kind

> **Closed by** `.github/workflows/ci.yml`: typecheck and unit suites on every push;
> the full suite with real Docker on pull requests and nightly, building the runner
> images in the job so the Dockerfiles are tested too; container-residue and
> `verify-readiness.sh` assertions; `gitleaks` on every push.

```
ls .github  → No such file or directory
```

An 814-test suite with real-Docker integration coverage, and nothing runs it but memory.
See §4.

### F8 — LOW — ⚠️ **PARTIALLY CLOSED 2026-09-29** — No structured logs, metrics, or error reporting

> **Closed:** `/api/health` now reports *why* it is unhealthy, naming the dependency —
> Docker unreachable, or the egress policy absent — instead of an unconditional
> `ok: true`. Unhandled rejections are recorded rather than lost.
>
> **Deferred, deliberately:** structured logging and counters. Both need a dependency on
> a project that hand-wrote a six-line `.env` loader rather than take one, and the
> decision was to take the dependency-free half now. See the changelog.

```
grep -c "console\." apps/backend/src/server.ts   → 6      (plain text to stdout)
grep -rniE "prom-client|/metrics|pino|winston|sentry" apps/backend/src   → no matches
```

**Reproduce:** the two commands above. Detail and remediation in §3.

### Verified sound — not findings

Each checked by running the command shown.

**Container confinement**, on a live container (`c=$(docker ps --filter label=com.devlaunch.managed -q | head -1)`):

```
docker inspect "$c" --format '…'
  ReadonlyRootfs=true CapDrop=[ALL] CapAdd=[] SecurityOpt=[no-new-privileges]
  Privileged=false PidsLimit=256 User=1000:1000
  Memory=1073741824  NetworkMode=devlaunch-net
  Binds=[devlaunch-cache-…:/cache]          ← the cache volume only
```

**No Docker socket inside:**

```
docker exec "$c" sh -c 'ls -l /var/run/docker.sock'
  ls: cannot access '/var/run/docker.sock': No such file or directory
```

**Egress policy genuinely blocks**, tested from inside a running container:

```
docker exec "$c" sh -c '…net.connect…'
  192.168.0.2:3939   blocked (timeout)   ← the host's own DevLaunch API
  169.254.169.254:80 blocked (timeout)   ← cloud metadata
  10.0.0.1:80        blocked (timeout)   ← RFC1918
  registry.npmjs.org:443  REACHABLE      ← installs still work
```

A malicious repository cannot call back into DevLaunch. Note this is *container* egress;
it says nothing about F1, which is inbound to the host.

**The Groq key does not reach runner containers:**

```
docker exec "$c" sh -c 'env | grep -ci groq'   → 0
docker exec "$c" sh -c 'env | grep -c DL_'     → 5      (the wrapper's own variables)
```

**No Groq key in git history** — narrow claim, narrow evidence:

```
git log -S 'gsk_' --oneline   → 0 commits
git check-ignore -v .env      → .gitignore:3:.env
```

This checks one prefix in history only. It is **not** a general secret scan: no
working-tree sweep, no `sk-`/`AKIA`/`ghp_`/`xox*` patterns. A real scanner
(`gitleaks`, `trufflehog`) has never been run on this repository — worth doing once.

**Teardown removes containers:** zero managed containers after every session in this
verification, including cancelled ones. (Volumes are a different story — F4.)

### Deliberate, and therefore not defects

Documented in `docs/limitations.md`, listed so a future reviewer does not re-raise them:

| Property | Why it is a decision |
|---|---|
| No authentication | Single-user local tool. Sound **once F1 is fixed**, not before. |
| Sessions and logs in memory | Restarting loses history; keeps SQLite out of the tree. |
| `maxSessions: 1` | The VM cannot safely host more; a second concurrent install risks OOM. |
| No repository Dockerfile support | Building one executes arbitrary `RUN` at build time. |
| Public GitHub over HTTPS only | Keeps the threat model small. |
| ARM64 only | x86 emulation under Colima blows the execution timeouts. |

### Not examined

Stated so absence is not mistaken for a clean bill:

- **`config/index.ts` ignores `.env` entirely.** Found while fixing F1 and outside its
  scope. That module is a frozen object evaluated at first import, which happens before
  `loadDotEnv()` runs in `startServer` — so every `intEnv(...)` constant honours an
  exported shell variable and silently ignores the same line in `.env`.
  `DEVLAUNCH_CONTAINER_MEMORY_MB` in a `.env` file does nothing today.

- **Supply chain.** No `npm audit`, no lockfile-integrity check, no CVE scan of the two
  runner base images that host untrusted code.
- **Cache poisoning as an attack.** F4 notes the persistent writable surface; whether a
  repository can influence another's cache key was not tested.
- **Startup with Docker absent.** What the process does when Colima is down was not
  exercised.
- **Upgrade, rollback, backup.** N/A by design — state is in memory — but never stated.

---

## 3. Observability recommendations

What exists:

| Surface | Gives |
|---|---|
| `GET /api/health` | liveness, session count, **build stamp** (running vs on-disk source, `stale`) |
| `GET /api/sessions`, `GET /api/sessions/:id` | state, plan, failure, repairs, warnings |
| `GET /api/sessions/:id/stats` | per-container CPU and memory, sampled on request |
| WebSocket log stream | live per-service output, ANSI-stripped, sequence-numbered, resumable |

The build stamp compares the **content** of `apps/backend/src` and `packages/shared/src`
against what the process loaded, not commit SHAs. Observed during this verification:

```
GET /api/health
  {"ok":true,"sessions":9,"build":{"running":"4356945…","head":"4d4b434…",
   "stale":false,"startedAt":1790605026027}}
```

Different commits, `stale:false` — correct, because the process started with those
changes already on disk. A SHA comparison would have raised a false alarm.

Gaps, in priority order:

1. **A reason when health is not ok.** `/api/health` returns an unconditional
   `{ok:true}` (`api/app.ts:122-128`). It cannot say "Docker is unreachable" or "the
   egress policy is missing" — both of which happened today. A readiness check naming its
   dependencies would have caught F5 automatically.
2. **Structured logs.** Six plain-text `console.*` calls in `server.ts`; nothing is
   machine-readable, so nothing can be filtered or aggregated.
3. **Counters.** Sessions started, READY rate, failure codes by frequency, repairs fired
   and whether they helped. The sweeps driving this week's work were measured with an
   ad-hoc script because the engine keeps none of this.
4. **Unhandled-rejection reporting.** The pipeline is a long `void`-ed async chain; a
   throw outside a `try` disappears into the process.
5. **Disk.** Nothing reports cache-volume growth. F4 went unnoticed for 99 volumes.

---

## 4. CI/CD suggestions

There is no pipeline. The suite is the project's strongest asset and nothing runs it.

- **Every push:** typecheck all three packages; unit suites
  (`--exclude '**/integration/**'`, ~24s backend + ~1s frontend). No Docker needed.
- **Pull requests and nightly:** the full suite. Needs a Docker daemon and the runner
  images; ~6 minutes. Build them in the job (`./scripts/build-runner-images.sh`) so the
  Dockerfiles are tested too.
- **Always:**
  `test "$(docker ps -a --filter label=com.devlaunch.managed -q | wc -l)" -eq 0` and the
  equivalent for volumes once F4 is fixed — residue is a real failure mode and the
  cheapest possible check.
- **Secret scanning:** `gitleaks detect` on every push. Never run here; five API keys
  have been pasted into chat transcripts this week, and only the `gsk_` prefix in history
  has ever been checked.
- **Architecture:** the suite targets arm64. On x86 runners the native-build fixtures
  behave differently — use arm64 runners or mark those tests.

`scripts/verify-readiness.sh` (added with this report) is designed as a CI step: it
asserts this document's load-bearing claims still hold, and `STRICT=1` makes it fail while
any finding remains open.

---

## Verdict

**As a local developer tool: ready, with F1 fixed first.** Well tested, genuinely
confining under live inspection, reliable teardown of containers, unusually honest failure
reporting. F1 is a one-line change plus a config entry and should happen before this next
runs on a network you do not control. F4 is a slow disk leak that will eventually matter.

**As a hosted multi-user service: not ready, and not designed to be.** No authentication,
no persistence, one session at a time, and an intake that executes what it is given.
Those are deliberate; making it hosted would be a different product.
