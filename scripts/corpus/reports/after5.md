# Corpus report — after5

Backend `fdba043` (stale: false), egress enforced, 2026-10-04T07:08:21.847Z.

The code measured is fdba043 plus the 2026-10-04 production-audit work, uncommitted at the time — including the end-to-end check before READY, which every READY run here passed. The full run hit a slow, failing network for part of its length (calculator: yarn 'trouble with your network connection'; Next.js and Nuxt installs taking 7–8 minutes); calculator, vercel/nextjs-portfolio-starter and the Poetry template were re-run alone afterwards, and calculator and the portfolio returned to their after4 results. The Poetry template is a cookiecutter template whose after4 pass was a model guess.

**30 / 40 READY** (75%), 0 planned by the model, 5 with a model repair, 47 min total.

| Outcome | Count |
|---|---|
| PASS | 30 |
| FAIL | 10 |

### Failures by code

| Failure code | Count |
|---|---|
| DEPENDENCY_INSTALL_FAILED | 3 |
| UNSUPPORTED_PROJECT | 2 |
| WRONG_RUNTIME_VERSION | 1 |
| PORT_NOT_LISTENING | 1 |
| MISSING_ENV | 1 |
| (COMPLETED, no port) | 1 |
| INVALID_AI_PLAN | 1 |

### Failures by label

| Label | Count |
|---|---|
| UNSUPPORTED_BY_CONTRACT | 8 |
| REPO_FAILURE | 2 |

## Results

| Repository | Category | Detected | Plan | State | Code | Stage | Label | s |
|---|---|---|---|---|---|---|---|---|
| mdn/beginner-html-site-styled | static | static | rule-based | READY |  |  | PASS | 4 |
| mdn/beginner-html-site-scripted ⚠ tip≠pin | static | static | rule-based | READY |  |  | PASS | 4 |
| mdn/todo-react | vite-react | vite | rule-based | READY |  |  | PASS | 45 |
| mdn/todo-vue ⚠ tip≠pin | vite-vue | vite | rule-based | READY |  |  | PASS | 6 |
| jguerraco/svelte-vite-app | vite-svelte | vite | rule-based | READY |  |  | PASS | 6 |
| ChrisWongAtCUHK/svelte-vite-app | vite-svelte | vite | rule-based | READY |  |  | PASS | 28 |
| sveltejs/template | svelte-rollup | node | rule-based | READY |  |  | PASS | 26 |
| ahfarmer/calculator | cra | cra | rule-based | FAILED | WRONG_RUNTIME_VERSION | start | UNSUPPORTED_BY_CONTRACT | 128 |
| shadcn-ui/next-template | next | next | rule-based | READY |  |  | PASS | 101 |
| vercel/nextjs-portfolio-starter | next | next | rule-based | READY |  |  | PASS | 93 |
| nuxt/starter | nuxt | nuxt | rule-based | READY |  |  | PASS | 412 |
| sveltejs/realworld | sveltekit | sveltekit | rule-based | READY |  |  | PASS | 18 |
| onwidget/astrowind | astro | astro | rule-based | READY |  |  | PASS | 35 |
| remix-run/indie-stack | remix | remix | rule-based | READY |  |  | PASS | 421 |
| gothinkster/angular-realworld-example-app | angular | angular | rule-based | FAILED | PORT_NOT_LISTENING | start | UNSUPPORTED_BY_CONTRACT | 207 |
| developit/express-es6-rest-api | express | express | rule-based | READY |  |  | PASS | 58 |
| danielfsousa/express-rest-boilerplate | express | express | ai-fallback | READY |  |  | PASS | 40 |
| bradtraversy/react_express_starter | express | project:web+api | rule-based | READY |  |  | PASS | 83 |
| fastify/demo | fastify | fastify | rule-based | FAILED | MISSING_ENV | start | REPO_FAILURE | 86 |
| jellydn/fastify-starter | fastify | fastify | rule-based | READY |  |  | PASS | 19 |
| nestjs/typescript-starter | nestjs | nest | rule-based | READY |  |  | PASS | 16 |
| ljlm0402/typescript-express-starter | ts-node | node | rule-based | COMPLETED | (COMPLETED, no port) | readiness | REPO_FAILURE | 10 |
| gothinkster/node-express-realworld-example-app | ts-node | express | rule-based | READY |  |  | PASS | 24 |
| sahat/hackathon-starter ⚠ tip≠pin | express | express | rule-based | READY |  |  | PASS | 40 |
| miguelgrinberg/microblog | flask | flask | ai-fallback | FAILED | DEPENDENCY_INSTALL_FAILED | install | UNSUPPORTED_BY_CONTRACT | 37 |
| JayBhatt2021/improved-flask-tutorial-app | flask | flask | rule-based | READY |  |  | PASS | 65 |
| testdrivenio/fastapi-crud-sync | fastapi | fastapi | rule-based | READY |  |  | PASS | 25 |
| max-pfeiffer/uvicorn-poetry-fastapi-project-template | poetry | fastapi | ai-fallback | FAILED | DEPENDENCY_INSTALL_FAILED | install | UNSUPPORTED_BY_CONTRACT | 14 |
| nsidnev/fastapi-realworld-example-app | poetry | fastapi | ai-fallback | FAILED | DEPENDENCY_INSTALL_FAILED | install | UNSUPPORTED_BY_CONTRACT | 27 |
| mdn/django-locallibrary-tutorial | django | django | rule-based | READY |  |  | PASS | 17 |
| pyCampaDB/pipenvDjango | pipenv | django | rule-based | READY |  |  | PASS | 12 |
| streamlit/demo-uber-nyc-pickups | streamlit | streamlit | rule-based | READY |  |  | PASS | 36 |
| streamlit/streamlit-example | streamlit | streamlit | rule-based | READY |  |  | PASS | 26 |
| gogetjax/gradio-app-demo | gradio | gradio | rule-based | READY |  |  | PASS | 34 |
| TakanoriOnuma/bun-react-vite | bun | vite | rule-based | READY |  |  | PASS | 51 |
| sadrozzy/Bun-React-Template | bun | — | — | FAILED | UNSUPPORTED_PROJECT | clone | UNSUPPORTED_BY_CONTRACT | 4 |
| patelharsh9797/bun-hono-app | bun | — | — | FAILED | UNSUPPORTED_PROJECT | clone | UNSUPPORTED_BY_CONTRACT | 3 |
| dan5py/turborepo-shadcn-ui | turborepo | next | rule-based | READY |  |  | PASS | 55 |
| ejazahm3d/fullstack-turborepo-starter | turborepo | project:web+api | rule-based | READY |  |  | PASS | 290 |
| nrwl/nx-examples ⚠ tip≠pin | nx | angular | ai-fallback | FAILED | INVALID_AI_PLAN | repair | UNSUPPORTED_BY_CONTRACT | 216 |

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
- message: Nothing is listening on port 4200. Sockets observed: 127.0.0.11:45043.
- evidence: `You can mark the path "realworld/assets/theme/styles.css" as external to exclude it from the bundle, which will remove this error and leave the unresolved path in the bundle.`

### fastify/demo — MISSING_ENV
**REPO_FAILURE** — Its dev script is `tsx --env-file=.env` and the repository ships only .env.example; its README tells a person to copy it. Now reported as MISSING_ENV naming .env, and MySQL is correctly reported ready.

- plan: `npm install --no-audit --no-fund` → `npm run dev` (node 20, port 3000, dir .)
- message: The start script loads .env with --env-file, and the repository has no such file.
- evidence: `node: .env: not found`

### ljlm0402/typescript-express-starter — (COMPLETED, no port)
**REPO_FAILURE** — A project-generator CLI, not an application. COMPLETED is the correct answer.

- plan: `pnpm install --frozen-lockfile` → `pnpm run start` (node 20, port 3000, dir .)

### miguelgrinberg/microblog — DEPENDENCY_INSTALL_FAILED
**UNSUPPORTED_BY_CONTRACT** — Pins a multidict with no Python 3.12 wheel; DevLaunch ships one Python.

- plan: `pip install -r requirements.txt` → `flask run --host=0.0.0.0 --port=5000` (python 3.11, port 5000, dir .)
- message: Dependency installation failed.
- evidence: `Failed to build multidict`
- repairs: ai:PLAN_REWRITE

### max-pfeiffer/uvicorn-poetry-fastapi-project-template — DEPENDENCY_INSTALL_FAILED
**UNSUPPORTED_BY_CONTRACT** — A cookiecutter template, not an application: its app directory is `{{cookiecutter.project_slug}}` and its pyproject.toml holds template placeholders (tomllib: Invalid statement at line 5). after4's PASS was a model plan (`pip install uvicorn fastapi`) that happened to work; this run's model plan did not. Candidate: recognise template repositories and decline them by rule.

- plan: `pip install -r requirements.txt` → `uvicorn app.main:app --host 0.0.0.0 --port 8000` (python 3.12, port 8000, dir {{cookiecutter.project_slug}})
- message: Dependency installation failed.
- evidence: `tomllib.TOMLDecodeError: Invalid statement (at line 5, column 1)`
- repairs: ai:PLAN_REWRITE

### nsidnev/fastapi-realworld-example-app — DEPENDENCY_INSTALL_FAILED
**UNSUPPORTED_BY_CONTRACT** — asyncpg ^0.26 has no Python 3.12 wheel and does not build; DevLaunch ships one Python. Reached by the rule plan (see reports/nsidnev-genreq).

- plan: `pip install -r /workspace/.devlaunch/requirements.txt asyncpg==0.29.0` → `uvicorn app.main:application --host 0.0.0.0 --port 8000` (python 3.12, port 8000, dir .)
- message: Dependency installation failed.
- evidence: `Failed to build asyncpg`
- repairs: ai:PLAN_REWRITE

### sadrozzy/Bun-React-Template — UNSUPPORTED_PROJECT
**UNSUPPORTED_BY_CONTRACT** — Its dev script is `bunx --bun vite`. Now declined in 3 seconds with the script named, and no model call.

- message: The `dev` script runs `bunx --bun vite`, which needs the Bun runtime. DevLaunch runs Node 20 and 22 and ships no Bun, so no plan it can make starts this project.

### patelharsh9797/bun-hono-app — UNSUPPORTED_PROJECT
**UNSUPPORTED_BY_CONTRACT** — Written for the Bun runtime. Now declined in 3 seconds with the script named, and no model call.

- message: The `dev` script runs `bun --watch server/index.ts`, which needs the Bun runtime. DevLaunch runs Node 20 and 22 and ships no Bun, so no plan it can make starts this project.

### nrwl/nx-examples — INVALID_AI_PLAN
**UNSUPPORTED_BY_CONTRACT** — Its install now fits: the memory policy climbed 1024 → 2048 → 4096 MB and yarn --immutable finished. Nx then fails with `WorkspaceContext is not a constructor`; outside DevLaunch the workspace needs a .NET toolchain for its @nx/dotnet plugin on Node 20 and 22 alike. after5: the model's plan named a script that does not exist (INVALID_AI_PLAN) — model variance on a repository that needs .NET for its Nx workspace context.

- plan: `yarn install --immutable` → `yarn run serve --host 0.0.0.0 --port 4200` (node 20, port 4200, dir .)
- message: The start command runs the script "serve", and package.json defines no such script. It defines: affected, affected:apps, affected:build, affected:dep-graph, affected:e2e, affected:libs, affected:lint, affected:test, build, dep-graph, e2e, format, format:check, format:write, help, lint, nx, start, test, update, workspace-generator.
- repairs: ai:PLAN_REWRITE
