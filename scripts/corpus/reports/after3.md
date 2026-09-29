# Corpus report — after3

Backend `6b03978` (stale: false), egress enforced, 2026-09-29T13:05:53.239Z.

The code measured is `6b03978` plus this session's install-detection and OOM-recovery work, uncommitted at the time. Strict installs: npm ci ×6, --frozen-lockfile ×7, --immutable ×1 — every one of them completed its install (the two of those runs that then failed did so afterwards: a generator CLI that exits, and Nx's own workspace error); one stale pnpm lockfile relaxed by rule (sveltejs/realworld). "With a model repair" counts applied repairs only.

**29 / 40 READY** (73%), 2 planned by the model, 4 with a model repair, 30 min total.

| Outcome | Count |
|---|---|
| PASS | 29 |
| FAIL | 11 |

### Failures by code

| Failure code | Count |
|---|---|
| DEPENDENCY_INSTALL_FAILED | 3 |
| START_COMMAND_FAILED | 2 |
| UNSUPPORTED_PROJECT | 2 |
| WRONG_RUNTIME_VERSION | 1 |
| PORT_NOT_LISTENING | 1 |
| MISSING_ENV | 1 |
| (COMPLETED, no port) | 1 |

### Failures by label

| Label | Count |
|---|---|
| UNSUPPORTED_BY_CONTRACT | 7 |
| REPO_FAILURE | 3 |
| DEVLAUNCH_BUG | 1 |

## Results

| Repository | Category | Detected | Plan | State | Code | Stage | Label | s |
|---|---|---|---|---|---|---|---|---|
| mdn/beginner-html-site-styled | static | static | rule-based | READY |  |  | PASS | 6 |
| mdn/beginner-html-site-scripted | static | static | rule-based | READY |  |  | PASS | 4 |
| mdn/todo-react | vite-react | vite | rule-based | READY |  |  | PASS | 39 |
| mdn/todo-vue | vite-vue | vite | rule-based | READY |  |  | PASS | 6 |
| jguerraco/svelte-vite-app | vite-svelte | vite | rule-based | READY |  |  | PASS | 6 |
| ChrisWongAtCUHK/svelte-vite-app | vite-svelte | vite | rule-based | READY |  |  | PASS | 12 |
| sveltejs/template | svelte-rollup | node | rule-based | READY |  |  | PASS | 10 |
| ahfarmer/calculator | cra | cra | rule-based | FAILED | WRONG_RUNTIME_VERSION | start | UNSUPPORTED_BY_CONTRACT | 69 |
| shadcn-ui/next-template | next | next | rule-based | READY |  |  | PASS | 40 |
| vercel/nextjs-portfolio-starter | next | next | rule-based | READY |  |  | PASS | 61 |
| nuxt/starter | nuxt | nuxt | rule-based | READY |  |  | PASS | 90 |
| sveltejs/realworld | sveltekit | sveltekit | rule-based | READY |  |  | PASS | 14 |
| onwidget/astrowind | astro | astro | rule-based | READY |  |  | PASS | 27 |
| remix-run/indie-stack | remix | remix | rule-based | READY |  |  | PASS | 252 |
| gothinkster/angular-realworld-example-app | angular | angular | rule-based | FAILED | PORT_NOT_LISTENING | start | UNSUPPORTED_BY_CONTRACT | 111 |
| developit/express-es6-rest-api | express | express | rule-based | READY |  |  | PASS | 26 |
| danielfsousa/express-rest-boilerplate | express | express | ai-fallback | READY |  |  | PASS | 106 |
| bradtraversy/react_express_starter | express | project:web+api | rule-based | READY |  |  | PASS | 67 |
| fastify/demo | fastify | fastify | rule-based | FAILED | MISSING_ENV | start | REPO_FAILURE | 47 |
| jellydn/fastify-starter | fastify | fastify | rule-based | READY |  |  | PASS | 14 |
| nestjs/typescript-starter | nestjs | nest | rule-based | READY |  |  | PASS | 9 |
| ljlm0402/typescript-express-starter | ts-node | node | rule-based | COMPLETED | (COMPLETED, no port) | readiness | REPO_FAILURE | 8 |
| gothinkster/node-express-realworld-example-app | ts-node | express | rule-based | READY |  |  | PASS | 23 |
| sahat/hackathon-starter ⚠ tip≠pin | express | express | rule-based | READY |  |  | PASS | 26 |
| miguelgrinberg/microblog | flask | ai-fallback | ai-fallback | FAILED | DEPENDENCY_INSTALL_FAILED | install | UNSUPPORTED_BY_CONTRACT | 24 |
| JayBhatt2021/improved-flask-tutorial-app | flask | ai-fallback | ai-fallback | FAILED | START_COMMAND_FAILED | start | DEVLAUNCH_BUG | 24 |
| testdrivenio/fastapi-crud-sync | fastapi | fastapi | rule-based | READY |  |  | PASS | 102 |
| max-pfeiffer/uvicorn-poetry-fastapi-project-template | poetry | fastapi | ai-fallback | FAILED | DEPENDENCY_INSTALL_FAILED | install | REPO_FAILURE | 7 |
| nsidnev/fastapi-realworld-example-app | poetry | fastapi | ai-fallback | FAILED | DEPENDENCY_INSTALL_FAILED | install | UNSUPPORTED_BY_CONTRACT | 107 |
| mdn/django-locallibrary-tutorial | django | django | rule-based | READY |  |  | PASS | 9 |
| pyCampaDB/pipenvDjango | pipenv | django | rule-based | READY |  |  | PASS | 7 |
| streamlit/demo-uber-nyc-pickups | streamlit | streamlit | rule-based | READY |  |  | PASS | 18 |
| streamlit/streamlit-example | streamlit | streamlit | rule-based | READY |  |  | PASS | 15 |
| gogetjax/gradio-app-demo | gradio | gradio | rule-based | READY |  |  | PASS | 17 |
| TakanoriOnuma/bun-react-vite | bun | vite | rule-based | READY |  |  | PASS | 17 |
| sadrozzy/Bun-React-Template | bun | — | — | FAILED | UNSUPPORTED_PROJECT | clone | UNSUPPORTED_BY_CONTRACT | 3 |
| patelharsh9797/bun-hono-app | bun | — | — | FAILED | UNSUPPORTED_PROJECT | clone | UNSUPPORTED_BY_CONTRACT | 3 |
| dan5py/turborepo-shadcn-ui | turborepo | next | rule-based | READY |  |  | PASS | 17 |
| ejazahm3d/fullstack-turborepo-starter | turborepo | project:web+api | rule-based | READY |  |  | PASS | 198 |
| nrwl/nx-examples | nx | angular | rule-based | FAILED | START_COMMAND_FAILED | start | UNSUPPORTED_BY_CONTRACT | 133 |

## Evidence

### ahfarmer/calculator — WRONG_RUNTIME_VERSION
**UNSUPPORTED_BY_CONTRACT** — webpack 4 under OpenSSL 3 (Node >= 17). The strict yarn install first refused a stale lockfile and was relaxed by rule; the failure reported is the one that stopped the run — WRONG_RUNTIME_VERSION, runtime too new — not the lockfile that was got past.

- plan: `yarn install` → `yarn run start` (node 20, port 3000, dir .)
- message: The build tool uses a hash OpenSSL 3 no longer provides, so it cannot run on Node 17 or newer — and DevLaunch has no older Node.
- evidence: `code: 'ERR_OSSL_EVP_UNSUPPORTED'`
- repairs: deterministic:START_COMMAND_CORRECTION

### gothinkster/angular-realworld-example-app — PORT_NOT_LISTENING
**UNSUPPORTED_BY_CONTRACT** — Bundles a stylesheet from the `realworld/` git submodule, which intake does not fetch by design. The plan now warns about it before the run; the failure itself still quotes esbuild.

- plan: `npm install --no-audit --no-fund` → `npm run start -- --host 0.0.0.0 --port 4200` (node 20, port 4200, dir .)
- message: Nothing is listening on port 4200. Sockets observed: 127.0.0.11:36183.
- evidence: `You can mark the path "realworld/assets/theme/styles.css" as external to exclude it from the bundle, which will remove this error and leave the unresolved path in the bundle.`

### fastify/demo — MISSING_ENV
**REPO_FAILURE** — Its dev script is `tsx --env-file=.env` and the repository ships only .env.example; its README tells a person to copy it. Now reported as MISSING_ENV naming .env, and MySQL is correctly reported ready.

- plan: `npm install --no-audit --no-fund` → `npm run dev` (node 20, port 3000, dir .)
- message: The start script loads .env with --env-file, and the repository has no such file.
- evidence: `node: .env: not found`
- configuration gate skipped, unset: COOKIE_SECRET

### ljlm0402/typescript-express-starter — (COMPLETED, no port)
**REPO_FAILURE** — A project-generator CLI, not an application. COMPLETED is the correct answer.

- plan: `pnpm install --frozen-lockfile` → `pnpm run start` (node 20, port 3000, dir .)

### miguelgrinberg/microblog — DEPENDENCY_INSTALL_FAILED
**UNSUPPORTED_BY_CONTRACT** — Pins a multidict with no Python 3.12 wheel; DevLaunch ships one Python.

- plan: `pip install --prefer-binary -r requirements.txt` → `flask run --host=0.0.0.0 --port=5000` (python 3.12, port 5000, dir .)
- message: Dependency installation failed.
- evidence: `Failed to build multidict`
- repairs: ai:PLAN_REWRITE

### JayBhatt2021/improved-flask-tutorial-app — START_COMMAND_FAILED
**DEVLAUNCH_BUG** — Not planned by rule (a Flask app factory, `flaskr:create_app`), so the model plans it — differently each run: gunicorn in baseline/after (passed), waitress in after2 (passed), `python -m gunicorn` without installing gunicorn in after3 (`gunicorn: not found`). Model variance, not the install or memory change; a rule for app factories would remove it.

- plan: `pip install -e .` → `python -m gunicorn -b 0.0.0.0:8336 flaskr:create_app` (python 3.12, port 8336, dir .)
- message: The start command could not be run: sh: 1: gunicorn: not found
- evidence: `sh: 1: gunicorn: not found`
- repairs: deterministic:START_COMMAND_CORRECTION

### max-pfeiffer/uvicorn-poetry-fastapi-project-template — DEPENDENCY_INSTALL_FAILED
**REPO_FAILURE** — A cookiecutter template; its pyproject.toml is not valid TOML until rendered.

- plan: `pip install -r requirements.txt` → `uvicorn app.main:app --host 0.0.0.0 --port 8000` (python 3.12, port 8000, dir {{cookiecutter.project_slug}})
- message: Dependency installation failed.
- evidence: `tomllib.TOMLDecodeError: Invalid statement (at line 5, column 1)`
- repairs: ai:PLAN_REWRITE

### nsidnev/fastapi-realworld-example-app — DEPENDENCY_INSTALL_FAILED
**UNSUPPORTED_BY_CONTRACT** — Its declared ranges are honoured, so it fails where it truly does: asyncpg ^0.26 has no Python 3.12 wheel and does not build. Still a generic DEPENDENCY_INSTALL_FAILED.

- plan: `pip install -r requirements.txt` → `uvicorn app.main:application --host 0.0.0.0 --port 8000` (python 3.11, port 8000, dir .)
- message: Dependency installation failed.
- evidence: `ERROR: Failed to build installable wheels for some pyproject.toml based projects (asyncpg)`
- repairs: ai:PLAN_REWRITE

### sadrozzy/Bun-React-Template — UNSUPPORTED_PROJECT
**UNSUPPORTED_BY_CONTRACT** — Its dev script is `bunx --bun vite`. Now declined in 3 seconds with the script named, and no model call.

- message: The `dev` script runs `bunx --bun vite`, which needs the Bun runtime. DevLaunch runs Node 20 and 22 and ships no Bun, so no plan it can make starts this project.

### patelharsh9797/bun-hono-app — UNSUPPORTED_PROJECT
**UNSUPPORTED_BY_CONTRACT** — Written for the Bun runtime. Now declined in 3 seconds with the script named, and no model call.

- message: The `dev` script runs `bun --watch server/index.ts`, which needs the Bun runtime. DevLaunch runs Node 20 and 22 and ships no Bun, so no plan it can make starts this project.

### nrwl/nx-examples — START_COMMAND_FAILED
**UNSUPPORTED_BY_CONTRACT** — Its install now fits: the memory policy climbed 1024 → 2048 → 4096 MB and yarn --immutable finished. Nx then fails with `WorkspaceContext is not a constructor`; outside DevLaunch the workspace needs a .NET toolchain for its @nx/dotnet plugin on Node 20 and 22 alike.

- plan: `yarn install --immutable` → `yarn run start --host 0.0.0.0 --port 4200 --disable-host-check` (node 20, port 4200, dir .)
- message: Start command exited with code 1.
- evidence: `TypeError: WorkspaceContext is not a constructor`
- repairs: deterministic:MEMORY_LIMIT_RAISED
