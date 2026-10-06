# Plan: from a local tool to a hosted service

**Written:** 2026-10-06 · **Starting point:** `53ea08a` · **Status:** proposal, nothing built yet

DevLaunch today is a tool one person runs on their own Mac. It is solid at that: 30 of 40
real repositories deploy and are checked end to end, every run is sandboxed, failures are
explained, and records survive a restart. This plan is what it would take to let **other
people** use it over the internet.

The short version: the deploying itself is mostly done. What is missing is everything
around it that a service with strangers as users needs: login, stronger walls between
users, a queue, public HTTPS addresses, limits, and monitoring.

---

## Step 0 — Decide who it is for (a decision, not code)

The answer changes how much of this plan is needed.

| Who uses it | What is needed |
|---|---|
| **You and a small, trusted team** | Steps 1, 3, 4, 6. Containers on a shared machine are acceptable when every user is trusted. |
| **Anyone on the internet** | Every step. Strangers will try to misuse it, so every deployment needs its own throwaway machine (step 2) and abuse controls (step 5). |

**Recommendation:** start with the trusted-team version. It is a few weeks of work and
proves the service shape. Open it to the public only after step 2 and step 5.

---

## Step 1 — Login and ownership

**Why:** today there is no login. That is safe only because DevLaunch listens on your own
computer. Anyone who can reach it can make it clone and run any code. On the internet, that
means strangers running code on your servers.

**Build:**
- Sign in with GitHub (OAuth). It also tells us who the person is on GitHub, which helps
  later with private repositories.
- Every deployment belongs to a user. A user sees and controls only their own: list, logs,
  stop, delete. The `/api/deployments` routes check ownership on every call.
- API tokens for the `./devlaunch` command and scripts, revocable, stored hashed.
- The live-log socket checks the same login.
- Keep `DEVLAUNCH_HOST` refusing to open beyond loopback unless login is switched on.

**Done when:** a request without a valid session is refused everywhere (API, log socket,
service URLs); one user cannot see or stop another's deployment; tests cover both.

**Size:** about 1 week.

---

## Step 2 — One throwaway machine per deployment

**Why:** today every repository runs in a locked-down container (non-root, read-only, no
extra rights, no Docker socket, limits on memory, CPU and processes). That is strong for a
laptop. But all containers share one Linux kernel. If a stranger's repository found a
kernel bug, it could reach other users' deployments. For public use, each deployment should
get its own small virtual machine that is destroyed afterwards.

**Build:**
- Run each deployment in a microVM (Firecracker, or gVisor/Kata as a step between),
  or a short-lived cloud VM. Keep the current container hardening *inside* it, so there
  are two walls instead of one.
- Hide this behind the existing launcher: `ExecutionManager` and `DockerManager` already
  give one place where containers are created, so a "VM launcher" can sit behind the same
  interface. Planning, repair and the end-to-end check do not need to change.
- Outgoing network: today it is open except for the home network and cloud metadata.
  For strangers, allow only package registries (npm, PyPI) and GitHub during install, and
  limit bandwidth after that. Otherwise people will use free machines to mine crypto or
  attack other sites.
- Package caches must not be shared between users (one user could poison a package
  another installs). Give each user their own, or use read-only shared caches.

**Done when:** a deployment cannot see another deployment's files, processes or network;
each machine is destroyed when the deployment ends; a test repository that tries to break
out, reach metadata, or scan the network is stopped and logged.

**Size:** about 3–4 weeks. The biggest and most important step for public use.

---

## Step 3 — A queue and separate workers

**Why:** today one process does everything, one deployment at a time
(`DEVLAUNCH_MAX_CONCURRENT_DEPLOYMENTS=1`), because a 6 GB laptop VM cannot hold more.
A service needs many at once, and needs the website to stay up while deployments run.

**Build:**
- Split into two parts: the **API/dashboard** (small, always on) and **workers** (do the
  deploying). They talk through a job queue.
- Move deployment records from files (`~/.devlaunch/deployments/*.json`) into Postgres.
  `DeploymentStore` is already an interface, so this is a new implementation of it.
- Keep logs in shared storage (not in one process's memory), so they survive restarts
  and can be read from any server. Today logs are lost after a restart.
- Workers report their spare memory and CPU; jobs go to a worker with room. Add more
  workers when the queue grows.
- A deployment whose worker dies is marked failed with that reason (the "interrupted"
  handling already does this for one machine).

**Done when:** ten deployments run at once; restarting the API does not lose any running
deployment or its logs; killing a worker marks its deployments failed with a clear reason.

**Size:** about 2 weeks.

---

## Step 4 — Public HTTPS addresses

**Why:** today a deployed app is at `http://localhost:<port>`, which only works on your own
computer. Users need a real address.

**Build:**
- Each deployment gets an address like `https://<id>.devlaunch-preview.app`, through a
  reverse proxy (Caddy or Traefik) with one wildcard certificate.
- **Use a separate domain** for user apps, never the dashboard's own domain. A user's app
  must not be able to read the dashboard's login cookies.
- DevLaunch's own dashboard and API on HTTPS.
- The end-to-end check and the frontend-to-API wiring use the public addresses.

**Done when:** a deployed app opens from any browser over HTTPS; it cannot read the
dashboard's cookies; the address stops working the moment the deployment stops.

**Size:** about 1 week.

---

## Step 5 — Limits and abuse controls

**Why:** a free service that runs any code from GitHub *will* be misused: crypto mining,
spam, and phishing pages served from your domain.

**Build:**
- Per-user limits: deployments at once, deployments per day, total running hours.
  (Idle and lifetime timers already exist; make them per user and stricter.)
- Size limits on repositories already exist; keep them.
- Preview addresses private by default (only the owner, signed in, can open them), with an
  explicit "share" option that expires. This removes most phishing value.
- A kill switch: stop every deployment of a user, or of a repository, at once.
- Watch for mining: CPU at 100% for a long time with no web traffic, and known mining
  pool addresses blocked.
- A page for reporting abuse, and terms of use.

**Done when:** a user hitting a limit gets a clear message; one command stops all of a
user's deployments; a test mining script is detected and stopped.

**Size:** about 1–2 weeks.

---

## Step 6 — Monitoring and running it

**Why:** on a laptop, you see when something breaks. A service needs to tell you.

**Build:**
- Metrics: deployments started, READY, failed (by failure category, which the error
  taxonomy already gives), time to READY, queue length, worker memory.
- Alerts: READY rate drops, queue stuck, workers full, disk filling.
- Error reporting for DevLaunch's own crashes (Sentry or similar).
- Structured logs (the deployment timeline already has the right shape).
- A staging copy, and releases that go to staging first.
- CI runs the long Docker suite (`./devlaunch test --all`) on every change, and the
  40-repo set nightly, so a change that breaks real repositories is caught the same day.
  (This is how the `remix-run/indie-stack` problem was caught on 2026-10-05.)
- Backups of the Postgres records.

**Done when:** an alert fires within minutes of the READY rate dropping; a bad release is
caught on staging; the nightly 40-repo run posts its result.

**Size:** about 1 week.

---

## Step 7 — Users' secret values

**Why:** some repositories need an API key (Stripe, OpenAI). Today they are typed into the
form and live only in memory for that run. A service must store them safely.

**Build:**
- Encrypt stored values; a value is never shown again after it is saved, never logged
  (already true for logs and records), and deleted with the deployment unless the user
  saves it to reuse.
- The model provider key (`GROQ_API_KEY`) belongs to the service, never shown to users;
  limit model calls per user so one user cannot spend the whole budget.

**Done when:** a saved secret cannot be read back through any API; deleting a deployment
deletes its secrets; a test confirms secrets never appear in logs, records or events.

**Size:** a few days.

---

## Running alongside: support more repositories

Separate from hosting, and worth doing in parallel. Of the 40 test repositories, 10 still
fail. From `scripts/corpus/reports/after6.md`:

| Group | Repositories | Next step |
|---|---|---|
| Python installs | microblog, uvicorn-poetry template, nsidnev | Look at each install failure; some are the repositories' own pins |
| Bun | Bun-React-Template, bun-hono-app | Bun runtime image |
| Node version | ahfarmer/calculator | An older Node image |
| Start / port | angular-realworld, nx-examples, typescript-express-starter | Case by case |
| Needs a setting | fastify/demo | Correct as is: it needs a value only the user has |

Beyond the 40: images for Go, Java and PHP; RabbitMQ, Kafka and Elasticsearch; private
repositories (after step 1 gives a GitHub login to use).

---

## Order and total

| Order | Step | Size | Needed for team use | Needed for public use |
|---|---|---|---|---|
| 1 | Login and ownership | ~1 week | yes | yes |
| 2 | Queue and workers | ~2 weeks | yes | yes |
| 3 | Public HTTPS addresses | ~1 week | yes | yes |
| 4 | Monitoring | ~1 week | yes | yes |
| 5 | Secret values | days | yes | yes |
| 6 | One machine per deployment | ~3–4 weeks | no | **yes** |
| 7 | Limits and abuse controls | ~1–2 weeks | light version | **yes** |

**Team version:** about 5–6 weeks for one developer.
**Public version:** about 10–12 weeks for one developer.

These are rough estimates for planning, not promises. Step 2 (one machine per deployment)
is the one most likely to take longer.

## What does not need to change

The core: cloning, understanding a repository, planning by rules, the command checks,
repairs, the end-to-end check before READY, the failure taxonomy and the deployment
timeline. These were built to be called through interfaces (`DeploymentStore`, the
launcher, the API), which is what lets steps 2–4 replace the parts around them instead of
rewriting them.
