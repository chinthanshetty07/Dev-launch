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
| `node-exit-ok` | A process that completes and exits 0. Through the readiness path — which watches for a port that is never going to open — this was reported as `UNKNOWN_RUNTIME_ERROR`; it is `COMPLETED` |
| `node-vite-app` | Vite detection, lockfile → npm, `engines.node`, framework config — and it actually serves. Its `tsconfig.json` was a zero-byte file for a long time and no test noticed, because planning and measuring a repository never parse it; the first run that started it died on `Unexpected end of file in JSON` |
| `python-flask-basic` | Flask detection, entry point and app variable, required env vars |
| `python-flask-factory` | A Flask app built by `create_app()` in `flaskr/__init__.py`, with no `app.py` — the official tutorial's layout. Planned by rule as `FLASK_APP=flaskr:create_app`; before, only a model could plan it, and did so differently each run |
| `python-django-basic` | Django detection from `manage.py`, and a server that answers. Its `DJANGO_SETTINGS_MODULE` pointed at `site.settings` with no `site/` directory — and `site` is a standard-library module, so every run failed with `'site' is not a package`. Analysis and planning read `manage.py` without importing anything, so no test saw it |
| `node-monorepo` | Workspace with exactly one runnable package |
| `node-monorepo-ambiguous` | Two runnable packages. The single-service planner asks which; through the ordinary path service discovery now finds both first and the project planner runs them together, which is a better answer than a question |
| `unrecognized-app` | No known framework and a non-approved script name, so only the AI fallback can plan it. Its README carries a live prompt injection, used to prove the allowlist rejects the payload |

## The repository's own Docker setup (fallback)

| Fixture | Exercises |
|---|---|
| `docker-go-api` | A Go server DevLaunch has no runtime for, run from its Dockerfile: built in the sandbox, run under the balanced profile, READY after the end-to-end check, nothing left on stop |
| `docker-compose-stack` | A compose project: a Go API built from source, official `postgres:16` and `redis:7`, started in `depends_on` order; the API answers 200 only when it reaches both by their compose names |
| `docker-refused` | `privileged: true` and the Docker socket: refused, both named, nothing started |
| `docker-breakout` | Probes metadata, the Docker bridge, the VM and private ranges from a build step and from the running container; every probe must print BLOCKED |
| `docker-daemon-fetch` | `ADD` from the metadata address — a download the Docker daemon makes itself, outside the egress rules: refused by name, nothing built |
| `docker-base-image-port` | No `EXPOSE` of its own on `nginx`: served on the port the image declares |
| `docker-port-convention` | No port declared anywhere; listens on `$PORT`: DevLaunch sets `PORT=8080` and checks it |

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
| `node-dies-after-ready` | `APPLICATION_EXITED` — serves a real request, then exits 3, three seconds after its first request. The one failure readiness alone cannot see |
| `python-slow-install` | An install that outlasts the readiness budget, then a normal start. Readiness must wait for the application, not the container |
| `node-bad-manifest` | `package.json` with a trailing comma: `INVALID_MANIFEST` before anything starts, with the parser's words; no model asked |
| `node-port-conflict` | Two servers on one port: `PORT_NOT_LISTENING`, "already in use" |
| `project-backend-fails` | A frontend that runs beside a backend that crashes: partly running, the backend named, the frontend kept up |
| `node-install-network` | A dependency from a host that does not exist: a dependency failure naming the host — not a network outage, which a well-known registry not resolving would be |

## Multi-service

| Fixture | Exercises |
|---|---|
| `python-stalled-startup` | A server that starts and never finishes starting. Uvicorn opens its socket only after the lifespan hook returns, so a hook waiting on something unreachable leaves a live container listening on nothing — and prints two INFO lines, no traceback, nothing error-shaped. Proves the failure carries the last line the application printed |
| `python-async-postgres` | One service that needs a Postgres it does not contain, reached through an **async** driver. Proves provisioning happens outside the multi-service path, and that the injected URL names the declared driver — a plain `postgresql://` sends SQLAlchemy to psycopg2 and fails against a healthy database. It answers only after a real `SELECT 1` |
| `node-fullstack` | `frontend/` + `backend/` with no root manifest, a hardcoded `http://localhost:5001` in the frontend, a backend that binds `5000`, and a MongoDB dependency. The ordinary shape of a web project, and the one a single-service runner gets wrong |

## Corpus regressions

One per DevLaunch bug the real-world corpus (`scripts/corpus/`) found, each driven by
`integration/corpusRegressions.test.ts` through analysis, rule-based planning, the
sandbox and readiness — so the test proves the application answers, not only that the
plan changed. Each was run against the unfixed code first and failed the way the real
repository did.

Where the defect lives in a tool's behaviour, the tool is **stood in for** by a tiny
package vendored under the fixture's `vendor/` and installed as a `file:` dependency:
the planner still recognises it by name, and nothing is downloaded. Each stand-in
reproduces the one behaviour at issue, quoted from the real tool in its source.

| Fixture | Reproduces |
|---|---|
| `node-bun-runtime` | `patelharsh9797/bun-hono-app`: every start script runs Bun. Driven through `SessionManager` by `bunRuntime.test.ts`, which asserts the explicit failure and that no model is asked |
| `node-bind-env` | `jellydn/fastify-starter`: a server bound by `process.env.SERVER_HOSTNAME ?? '127.0.0.1'`, which reads no `HOST` |
| `node-cra-stdin` | `ahfarmer/calculator`: a Create React App dev server that closes when stdin ends unless `CI=true`, as `react-scripts/scripts/start.js` does from 3.4.1 |
| `node-openssl-legacy` | `ahfarmer/calculator`, once it stays up: webpack 4's `md4` hash under OpenSSL 3, reproduced with `createHash('md4')` and no webpack |
| `node-pnpm-vite-args` | `sveltejs/realworld`: pnpm forwards a literal `--` to the script, and a Vite-like parser reads the flags after it as positional — so the server binds loopback |
| `node-submodule` | `angular-realworld`, once it starts: an application reading a file from a git submodule, which intake does not fetch. Its `.gitmodules` is an ordinary file here — git gives the name meaning only at a repository's root |
| `node-workspace-one-app` | `dan5py/turborepo-shadcn-ui`: a pnpm workspace whose one runnable package imports a sibling through `workspace:*` |
| `node-ts-type-error` | A TypeScript server with a type error that does not matter at run time, under ts-node. Reported as not compiling, quoting the error line, then retried once with `TS_NODE_TRANSPILE_ONLY=true`, after which it serves |
| `python-fastapi-https` | A FastAPI app that refuses plain HTTP, whose README runs uvicorn with `--ssl-certfile`/`--ssl-keyfile`. Served over HTTPS with a throwaway certificate the test makes, so no key is committed |
| `node-nodemon-crash` | A TypeScript server with a type error, under nodemon: the container stays up after the crash. DevLaunch must stop waiting on `[nodemon] app crashed` and then repair it |
| `static-site` | `mdn/beginner-html-site-styled`: an `index.html` with no manifest, which passed only when a model planned it. It has no `favicon.ico`, and the browser's request for one gets 204 from DevLaunch's static server, not a 404 in the console |
| `static-site-favicon` | A static page that ships its own `favicon.ico`, which must be served unchanged — the 204 is only for a site without one |
| `python-poetry-ranges` | `nsidnev/fastapi-realworld-example-app`: a Poetry project that is not a buildable package, whose code needs the major version its manifest pins (`flask = "^2.3"`), and refuses Flask 3 — as nsidnev's needed pydantic 1. Needs PyPI |
| `node-angular-build` | `gothinkster/angular-realworld-example-app`: an `ng serve` that validates flags against its builder's schema, as the real CLI does, on `@angular/build:dev-server` — which has no `--disable-host-check` |
| `node-install-noise` | `fastify/demo` and `angular-realworld`: an install that succeeds while printing npm's `EBADENGINE` warnings and husky's `git command not found`, then a start that fails for its own reason — `node --env-file=.env` with only `.env.example`, a refused flag, or a process that never listens |
| `node-needs-mysql` | `fastify/demo`: an application that needs a MySQL it does not contain, and answers only after reading MySQL's own greeting packet from it. Driven through `SessionManager` by `integration/singleServiceDatabase.test.ts`, which also asserts the provisioner *knew* the database was ready |
| `node-install-oom` | `horusyeung/nextjs-nestjs-fullstack-starter`'s shape: an install step that needs ~1.4 GB, killed by the kernel at 1024 MB (Docker `OOMKilled`, wrapper exit 110) and fine at 2048 MB. Driven by `integration/memoryEscalation.test.ts` |

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
- **A success fixture proves the round trip, not the process.** `python-async-postgres`
  is the exception to the zero-dependency rule, deliberately: the failure it exists for
  — a synchronous driver behind an async engine — happens at connect time, so a fixture
  that merely started would have passed while the defect was still there.

## Running them is not the same as planning them

Three fixtures were correct to every test that touched them and broken the moment they
ran: `node-vite-app` (a zero-byte `tsconfig.json`), `python-django-basic` (a settings
module that could never be imported), and `node-monorepo`'s web package (no page to
serve). Analysis and planning read manifests; they do not execute anything, so a fixture
that is only ever analysed can stay broken indefinitely.

The full sweep is what found them — every fixture launched through `SessionManager`
against real Docker, to a terminal state, with its URL fetched. `node-install-fail` and
`python-slow-install` are the deliberate exceptions: both are driven with an explicit
plan by their own tests, and through the ordinary rule-based path the first installs
cleanly and the second is correctly `UNSUPPORTED_PROJECT`.
