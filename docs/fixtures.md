# Fixtures

Fixtures are **vendored in-repo**, not cloned from GitHub. That makes the suite
deterministic, offline, fast, and free of rate limits — and, more importantly, it means
each failure mode is reproduced *precisely*. The "wrong port" fixture fails exactly that
way, every time.

Two or three real GitHub repositories are kept as a **manual smoke list** for demos.
They are deliberately not in the automated suite.

## Success paths

| Fixture | Exercises |
|---|---|
| `node-http-basic` | Zero-dependency HTTP server; the baseline happy path |
| `node-exit-ok` | A process that completes and exits 0 |
| `node-vite-app` | Vite detection, lockfile → npm, `engines.node`, framework config |
| `python-flask-basic` | Flask detection, entry point and app variable, required env vars |
| `python-django-basic` | Django detection from `manage.py` |
| `node-monorepo` | Workspace with exactly one runnable package |
| `node-monorepo-ambiguous` | Two runnable packages → the user is asked which |

## Failure paths

| Fixture | Expected outcome |
|---|---|
| `node-bind-localhost` | `PORT_BOUND_TO_LOCALHOST` — healthy server, unreachable |
| `node-never-listens` | `PORT_NOT_LISTENING` — running process, no socket |
| `node-slow-start` | Ready only after a delay; forces readiness to actually retry |
| `node-404-root` | READY despite 404 on `/`; health hint records the mismatch |
| `node-install-fail` | `DEPENDENCY_INSTALL_FAILED` via `npm ci` with no lockfile |
| `node-missing-env` | `MISSING_ENV`, with the variable named in the evidence |
| `node-needs-database` | `DATABASE_REQUIRED` from a refused connection on :5432 |
| `node-module-missing` | `START_COMMAND_FAILED`, naming the missing module |

## Instrumentation

| Fixture | Purpose |
|---|---|
| `node-security-probe` | Reports what the **kernel** enforces from inside the container: uid, `CapEff`, rootfs writability, socket presence, cgroup limits, and egress reachability |

The probe is what makes the security suite meaningful. Asserting Docker's configuration
would only prove what we asked for; the probe proves what is actually in force.

## Design rules

- **Zero dependencies wherever possible.** Fixtures that need `npm install` make the
  suite slow and network-dependent. Most use only the Node or Python standard library.
- **Each fixture fails one way.** A fixture with two defects cannot prove which one a
  classifier detected.
- **Expected plans are snapshotted.** `node-http-basic` carries an
  `expected-run-plan.json`, so rule-based detection is assertion-tested rather than
  eyeballed.
- **Failure fixtures reproduce shape, not machinery.** `node-needs-database` opens a
  raw socket to :5432 rather than pulling in a Postgres driver — the log output is what
  the classifier sees, and that is what matters.
