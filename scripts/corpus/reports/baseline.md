# Corpus report — baseline

Backend `c68f255` (stale: false), egress enforced, 2026-09-29.

The code measured is `c68f255` exactly. The three repositories behind a configuration gate were re-run with the gate skipped by the same process, so both runs use the same method.

**26 / 40 READY** (65%), 5 planned by the model, 10 with a model repair, 49 min total.

| Outcome | Count |
|---|---|
| PASS | 26 |
| FAIL | 14 |

### Failures by code

| Failure code | Count |
|---|---|
| DEPENDENCY_INSTALL_FAILED | 5 |
| START_COMMAND_FAILED | 4 |
| (COMPLETED, no port) | 2 |
| WRONG_RUNTIME_VERSION | 1 |
| PORT_BOUND_TO_LOCALHOST | 1 |
| OUT_OF_MEMORY | 1 |

### Failures by label

| Label | Count |
|---|---|
| DEVLAUNCH_BUG | 9 |
| UNSUPPORTED_BY_CONTRACT | 3 |
| REPO_FAILURE | 2 |

## Results

| Repository | Category | Detected | Plan | State | Code | Stage | Label | s |
|---|---|---|---|---|---|---|---|---|
| mdn/beginner-html-site-styled | static | ai-fallback | ai-fallback | READY |  |  | PASS | 6 |
| mdn/beginner-html-site-scripted | static | ai-fallback | ai-fallback | READY |  |  | PASS | 8 |
| mdn/todo-react | vite-react | vite | rule-based | READY |  |  | PASS | 37 |
| mdn/todo-vue | vite-vue | vite | rule-based | READY |  |  | PASS | 6 |
| jguerraco/svelte-vite-app | vite-svelte | vite | rule-based | READY |  |  | PASS | 6 |
| ChrisWongAtCUHK/svelte-vite-app | vite-svelte | vite | rule-based | READY |  |  | PASS | 8 |
| sveltejs/template | svelte-rollup | node | rule-based | READY |  |  | PASS | 12 |
| ahfarmer/calculator | cra | cra | rule-based | COMPLETED | (COMPLETED, no port) | readiness | DEVLAUNCH_BUG | 53 |
| shadcn-ui/next-template | next | next | rule-based | READY |  |  | PASS | 51 |
| vercel/nextjs-portfolio-starter | next | next | rule-based | READY |  |  | PASS | 39 |
| nuxt/starter | nuxt | ai-fallback | ai-fallback | FAILED | DEPENDENCY_INSTALL_FAILED | install | DEVLAUNCH_BUG | 12 |
| sveltejs/realworld | sveltekit | sveltekit | ai-fallback | FAILED | DEPENDENCY_INSTALL_FAILED | install | DEVLAUNCH_BUG | 69 |
| onwidget/astrowind | astro | astro | rule-based | READY |  |  | PASS | 32 |
| remix-run/indie-stack | remix | remix | rule-based | READY |  |  | PASS | 246 |
| gothinkster/angular-realworld-example-app | angular | angular | ai-fallback | FAILED | START_COMMAND_FAILED | start | DEVLAUNCH_BUG | 86 |
| developit/express-es6-rest-api | express | express | rule-based | READY |  |  | PASS | 35 |
| danielfsousa/express-rest-boilerplate | express | express | ai-fallback | READY |  |  | PASS | 122 |
| bradtraversy/react_express_starter | express | project:web+api | rule-based | READY |  |  | PASS | 76 |
| fastify/demo | fastify | fastify | rule-based | FAILED | WRONG_RUNTIME_VERSION | start | DEVLAUNCH_BUG | 465 |
| jellydn/fastify-starter | fastify | fastify | ai-fallback | FAILED | PORT_BOUND_TO_LOCALHOST | start | DEVLAUNCH_BUG | 146 |
| nestjs/typescript-starter | nestjs | nest | rule-based | READY |  |  | PASS | 11 |
| ljlm0402/typescript-express-starter | ts-node | node | rule-based | COMPLETED | (COMPLETED, no port) | readiness | REPO_FAILURE | 11 |
| gothinkster/node-express-realworld-example-app | ts-node | express | rule-based | READY |  |  | PASS | 27 |
| sahat/hackathon-starter | express | express | rule-based | READY |  |  | PASS | 204 |
| miguelgrinberg/microblog | flask | ai-fallback | ai-fallback | FAILED | DEPENDENCY_INSTALL_FAILED | install | UNSUPPORTED_BY_CONTRACT | 54 |
| JayBhatt2021/improved-flask-tutorial-app | flask | ai-fallback | ai-fallback | READY |  |  | PASS | 47 |
| testdrivenio/fastapi-crud-sync | fastapi | fastapi | rule-based | READY |  |  | PASS | 102 |
| max-pfeiffer/uvicorn-poetry-fastapi-project-template | poetry | fastapi | ai-fallback | FAILED | DEPENDENCY_INSTALL_FAILED | install | REPO_FAILURE | 9 |
| nsidnev/fastapi-realworld-example-app | poetry | fastapi | ai-fallback | FAILED | START_COMMAND_FAILED | start | DEVLAUNCH_BUG | 44 |
| mdn/django-locallibrary-tutorial | django | django | rule-based | READY |  |  | PASS | 18 |
| pyCampaDB/pipenvDjango | pipenv | django | rule-based | READY |  |  | PASS | 11 |
| streamlit/demo-uber-nyc-pickups | streamlit | streamlit | rule-based | READY |  |  | PASS | 86 |
| streamlit/streamlit-example | streamlit | streamlit | rule-based | READY |  |  | PASS | 96 |
| gogetjax/gradio-app-demo | gradio | gradio | rule-based | READY |  |  | PASS | 77 |
| TakanoriOnuma/bun-react-vite | bun | vite | rule-based | READY |  |  | PASS | 25 |
| sadrozzy/Bun-React-Template | bun | vite | ai-fallback | FAILED | START_COMMAND_FAILED | start | UNSUPPORTED_BY_CONTRACT | 49 |
| patelharsh9797/bun-hono-app | bun | project:web+api | rule-based | FAILED | START_COMMAND_FAILED | start | UNSUPPORTED_BY_CONTRACT | 62 |
| dan5py/turborepo-shadcn-ui | turborepo | next | ai-fallback | FAILED | DEPENDENCY_INSTALL_FAILED | install | DEVLAUNCH_BUG | 84 |
| ejazahm3d/fullstack-turborepo-starter | turborepo | project:web+api | rule-based | READY |  |  | PASS | 231 |
| nrwl/nx-examples | nx | angular | rule-based | FAILED | OUT_OF_MEMORY | install | DEVLAUNCH_BUG | 155 |

## Evidence

### ahfarmer/calculator — (COMPLETED, no port)
**DEVLAUNCH_BUG** — react-scripts >= 3.4.1 exits its dev server when stdin ends unless CI=true; the plan never sets it, and the exit 0 is then reported as COMPLETED.

- plan: `yarn install` → `yarn run start` (node 20, port 3000, dir .)

### nuxt/starter — DEPENDENCY_INSTALL_FAILED
**DEVLAUNCH_BUG** — No ref selection: the default branch `templates` is not the application; the app lives on `v3`.

- plan: `npm install` → `npm run dev` (node 20, port 3000, dir .)
- message: Dependency installation failed.
- evidence: `npm error A complete log of this run can be found in: /cache/npm/_logs/2026-09-29T07_22_11_712Z-debug-0.log`

### sveltejs/realworld — DEPENDENCY_INSTALL_FAILED
**DEVLAUNCH_BUG** — pnpm forwards a literal `--`, so `pnpm run dev -- --host 0.0.0.0` never reaches vite as options (PORT_BOUND_TO_LOCALHOST); and ERR_PNPM_UNSUPPORTED_ENGINE is classified as a generic install failure instead of a runtime version, so the deterministic Node 22 repair never fires and a model call is spent. The repository's own pnpm-lock.yaml is also broken (duplicated mapping key).

- plan: `pnpm install --no-lockfile` → `pnpm run dev -- --host 0.0.0.0 --port 5173` (node 22, port 5173, dir .)
- message: Dependency installation failed.
- evidence: `To fix this issue, install the required Node version.`
- repairs: ai:PLAN_REWRITE

### gothinkster/angular-realworld-example-app — START_COMMAND_FAILED
**DEVLAUNCH_BUG** — The Angular plan appends `--disable-host-check`, which the current Angular CLI (21) rejects: `Unknown argument: disable-host-check`. The diagnosis quoted husky's install-time `git command not found` instead.

- plan: `npm ci --ignore-scripts` → `npm run start -- --host 0.0.0.0 --port 4200` (node 20, port 4200, dir .)
- message: The start command could not be run: git command not found
- evidence: `git command not found`
- repairs: ai:PLAN_REWRITE

### fastify/demo — WRONG_RUNTIME_VERSION
**DEVLAUNCH_BUG** — Every MySQL readiness check fails (`mysqladmin ping` without `-u root` runs as OS user `mysql` and is denied), so a healthy MySQL is reported as not starting. The run itself then fails on `tsx --env-file=.env` with no .env — which was diagnosed WRONG_RUNTIME_VERSION from npm's EBADENGINE *warnings*.

- plan: `npm install --no-audit --no-fund` → `npm run dev` (node 22, port 3000, dir .)
- message: The project requires a runtime version that is not available.
- evidence: `npm warn EBADENGINE }`
- repairs: deterministic:START_COMMAND_CORRECTION
- configuration gate skipped, unset: COOKIE_SECRET

### jellydn/fastify-starter — PORT_BOUND_TO_LOCALHOST
**DEVLAUNCH_BUG** — The server binds `process.env.SERVER_HOSTNAME ?? '127.0.0.1'`; the variable it reads for its bind address is never discovered or set.

- plan: `pnpm install` → `pnpm run dev` (node 20, port 3000, dir .)
- message: The application is listening on 127.0.0.1:3000, which is reachable only from inside the container. Docker port mapping cannot forward to it. Bind 0.0.0.0 instead.
- repairs: ai:PLAN_REWRITE

### ljlm0402/typescript-express-starter — (COMPLETED, no port)
**REPO_FAILURE** — A project-generator CLI, not an application. COMPLETED (ran and exited 0, opened no port) is the correct answer.

- plan: `pnpm install` → `pnpm run start` (node 20, port 3000, dir .)

### miguelgrinberg/microblog — DEPENDENCY_INSTALL_FAILED
**UNSUPPORTED_BY_CONTRACT** — Pins a multidict with no Python 3.12 wheel, which fails to build from source; DevLaunch ships one Python.

- plan: `pip install --prefer-binary -r requirements.txt` → `gunicorn -b 0.0.0.0:5000 microblog:app` (python 3.12, port 5000, dir .)
- message: Dependency installation failed.
- evidence: `ERROR: Failed to build installable wheels for some pyproject.toml based projects (multidict)`
- repairs: ai:PLAN_REWRITE

### max-pfeiffer/uvicorn-poetry-fastapi-project-template — DEPENDENCY_INSTALL_FAILED
**REPO_FAILURE** — A cookiecutter template: the application directory is literally `{{cookiecutter.project_slug}}` and its pyproject.toml is not valid TOML until rendered. A poor corpus choice for 'a Poetry project'.

- plan: `pip install -r requirements.txt` → `uvicorn app.main:app --host 0.0.0.0 --port 8000` (python 3.12, port 8000, dir {{cookiecutter.project_slug}})
- message: Dependency installation failed.
- evidence: `tomllib.TOMLDecodeError: Invalid statement (at line 5, column 1)`
- repairs: ai:PLAN_REWRITE

### nsidnev/fastapi-realworld-example-app — START_COMMAND_FAILED
**DEVLAUNCH_BUG** — poetry.lock is ignored: dependencies install by name, unpinned, pydantic 2 arrives, and `BaseSettings` has moved.

- plan: `pip install uvicorn fastapi pydantic==1.10.15 passlib pyjwt databases asyncpg psycopg2-binary aiosql pypika alembic python-slugify unidecode loguru` → `uvicorn app.main:application --host 0.0.0.0 --port 8000` (python 3.12, port 8000, dir .)
- message: Start command exited with code 1.
- evidence: `pydantic.errors.PydanticImportError: 'BaseSettings' has been moved to the 'pydantic-settings' package. See https://docs.pydantic.dev/2.13/migration/#basesettings-has-moved-to-pydantic-settings for more details.`
- repairs: ai:PLAN_REWRITE

### sadrozzy/Bun-React-Template — START_COMMAND_FAILED
**UNSUPPORTED_BY_CONTRACT** — Its dev script is `bunx --bun vite`: the Bun binary is required and DevLaunch ships none. The failure (`bunx: not found`, then a model call) does not say so.

- plan: `npm install --no-audit --no-fund` → `vite --host 0.0.0.0 --port 5173` (node 20, port 5173, dir .)
- message: The start command could not be run: sh: 1: bunx: not found
- evidence: `sh: 1: bunx: not found`
- repairs: ai:PLAN_REWRITE

### patelharsh9797/bun-hono-app — START_COMMAND_FAILED
**UNSUPPORTED_BY_CONTRACT** — Runs on the Bun runtime (`bun run --hot`). DevLaunch ships no Bun; the report is a bare `bun: not found`.

- service api [api] FAILED START_COMMAND_FAILED `npm run dev`
- service frontend [web] FAILED START_COMMAND_FAILED `npm run dev -- --host 0.0.0.0 --port 5173`
- message: api: The start command could not be run: sh: 1: bun: not found
- evidence: `sh: 1: bun: not found`

### dan5py/turborepo-shadcn-ui — DEPENDENCY_INSTALL_FAILED
**DEVLAUNCH_BUG** — A workspace with one runnable package is planned from that package alone: npm (the package has no lockfile or packageManager), installed in apps/docs, where `workspace:*` cannot resolve. The root's pnpm-lock.yaml, packageManager and install were ignored.

- plan: `pnpm install` → `pnpm run dev -- -H 0.0.0.0 -p 3000` (node 20, port 3000, dir apps/docs)
- message: A package was installed on its own, but it depends on a sibling through the workspace protocol, which only a workspace-aware install can resolve.
- evidence: `npm error Unsupported URL Type "workspace:": workspace:*`
- repairs: ai:PLAN_REWRITE, deterministic:MEMORY_LIMIT_RAISED

### nrwl/nx-examples — OUT_OF_MEMORY
**DEVLAUNCH_BUG** — Detected as Angular at the root, so `yarn run start -- --host 0.0.0.0 --port 4200 --disable-host-check` — Yarn 4 forwards the `--`, and the flag no longer exists. Install then OOMs at the 2955 MB ceiling and Nx fails with `WorkspaceContext is not a constructor`. Partly the size of the repository.

- plan: `yarn install` → `yarn run start -- --host 0.0.0.0 --port 4200 --disable-host-check` (node 20, port 4200, dir .)
- message: The process was killed for exceeding the container memory limit.
- evidence: `Killed`
- repairs: deterministic:MEMORY_LIMIT_RAISED
