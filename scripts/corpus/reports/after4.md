# Corpus report — after4

Backend `49d56b7` (stale: false), egress enforced, 2026-09-29T19:54:17.998Z.

The code measured is `49d56b7` plus one uncommitted change: the memory ledger releases a hold whose container Docker no longer has (a live run had been refused memory by eight leaked holds). The backend was restarted for this run, so its ledger started empty. Two repositories (dan5py/turborepo-shadcn-ui, ejazahm3d/fullstack-turborepo-starter) were stopped from the dashboard mid-run and re-run with --only; both passed. Against after3: JayBhatt passes by the new Flask factory rule; the Poetry template passes, its rule plan rewritten by the model; nsidnev now fails earlier, on a generated-file path the model used in its build step.

**31 / 40 READY** (78%), 0 planned by the model, 4 with a model repair, 33 min total.

| Outcome | Count |
|---|---|
| PASS | 31 |
| FAIL | 9 |

### Failures by code

| Failure code | Count |
|---|---|
| UNSUPPORTED_PROJECT | 2 |
| WRONG_RUNTIME_VERSION | 1 |
| PORT_NOT_LISTENING | 1 |
| MISSING_ENV | 1 |
| (COMPLETED, no port) | 1 |
| DEPENDENCY_INSTALL_FAILED | 1 |
| BUILD_FAILED | 1 |
| START_COMMAND_FAILED | 1 |

### Failures by label

| Label | Count |
|---|---|
| UNSUPPORTED_BY_CONTRACT | 6 |
| REPO_FAILURE | 2 |
| DEVLAUNCH_BUG | 1 |

## Results

| Repository | Category | Detected | Plan | State | Code | Stage | Label | s |
|---|---|---|---|---|---|---|---|---|
| mdn/beginner-html-site-styled | static | static | rule-based | READY |  |  | PASS | 4 |
| mdn/beginner-html-site-scripted | static | static | rule-based | READY |  |  | PASS | 4 |
| mdn/todo-react | vite-react | vite | rule-based | READY |  |  | PASS | 20 |
| mdn/todo-vue | vite-vue | vite | rule-based | READY |  |  | PASS | 6 |
| jguerraco/svelte-vite-app | vite-svelte | vite | rule-based | READY |  |  | PASS | 5 |
| ChrisWongAtCUHK/svelte-vite-app | vite-svelte | vite | rule-based | READY |  |  | PASS | 8 |
| sveltejs/template | svelte-rollup | node | rule-based | READY |  |  | PASS | 11 |
| ahfarmer/calculator | cra | cra | rule-based | FAILED | WRONG_RUNTIME_VERSION | start | UNSUPPORTED_BY_CONTRACT | 73 |
| shadcn-ui/next-template | next | next | rule-based | READY |  |  | PASS | 37 |
| vercel/nextjs-portfolio-starter | next | next | rule-based | READY |  |  | PASS | 33 |
| nuxt/starter | nuxt | nuxt | rule-based | READY |  |  | PASS | 100 |
| sveltejs/realworld | sveltekit | sveltekit | rule-based | READY |  |  | PASS | 18 |
| onwidget/astrowind | astro | astro | rule-based | READY |  |  | PASS | 22 |
| remix-run/indie-stack | remix | remix | rule-based | READY |  |  | PASS | 254 |
| gothinkster/angular-realworld-example-app | angular | angular | rule-based | FAILED | PORT_NOT_LISTENING | start | UNSUPPORTED_BY_CONTRACT | 114 |
| developit/express-es6-rest-api | express | express | rule-based | READY |  |  | PASS | 34 |
| danielfsousa/express-rest-boilerplate | express | express | ai-fallback | READY |  |  | PASS | 105 |
| bradtraversy/react_express_starter | express | project:web+api | rule-based | READY |  |  | PASS | 67 |
| fastify/demo | fastify | fastify | rule-based | FAILED | MISSING_ENV | start | REPO_FAILURE | 53 |
| jellydn/fastify-starter | fastify | fastify | rule-based | READY |  |  | PASS | 14 |
| nestjs/typescript-starter | nestjs | nest | rule-based | READY |  |  | PASS | 9 |
| ljlm0402/typescript-express-starter | ts-node | node | rule-based | COMPLETED | (COMPLETED, no port) | readiness | REPO_FAILURE | 12 |
| gothinkster/node-express-realworld-example-app | ts-node | express | rule-based | READY |  |  | PASS | 19 |
| sahat/hackathon-starter ⚠ tip≠pin | express | express | rule-based | READY |  |  | PASS | 27 |
| miguelgrinberg/microblog | flask | flask | ai-fallback | FAILED | DEPENDENCY_INSTALL_FAILED | install | UNSUPPORTED_BY_CONTRACT | 17 |
| JayBhatt2021/improved-flask-tutorial-app | flask | flask | rule-based | READY |  |  | PASS | 14 |
| testdrivenio/fastapi-crud-sync | fastapi | fastapi | rule-based | READY |  |  | PASS | 103 |
| max-pfeiffer/uvicorn-poetry-fastapi-project-template | poetry | fastapi | ai-fallback | READY |  |  | PASS | 11 |
| nsidnev/fastapi-realworld-example-app | poetry | fastapi | ai-fallback | FAILED | BUILD_FAILED | build | DEVLAUNCH_BUG | 110 |
| mdn/django-locallibrary-tutorial | django | django | rule-based | READY |  |  | PASS | 9 |
| pyCampaDB/pipenvDjango | pipenv | django | rule-based | READY |  |  | PASS | 7 |
| streamlit/demo-uber-nyc-pickups | streamlit | streamlit | rule-based | READY |  |  | PASS | 22 |
| streamlit/streamlit-example | streamlit | streamlit | rule-based | READY |  |  | PASS | 20 |
| gogetjax/gradio-app-demo | gradio | gradio | rule-based | READY |  |  | PASS | 20 |
| TakanoriOnuma/bun-react-vite | bun | vite | rule-based | READY |  |  | PASS | 23 |
| sadrozzy/Bun-React-Template | bun | — | — | FAILED | UNSUPPORTED_PROJECT |  | UNSUPPORTED_BY_CONTRACT | 2 |
| patelharsh9797/bun-hono-app | bun | — | — | FAILED | UNSUPPORTED_PROJECT | analyse | UNSUPPORTED_BY_CONTRACT | 3 |
| dan5py/turborepo-shadcn-ui | turborepo | next | rule-based | READY |  |  | PASS | 36 |
| ejazahm3d/fullstack-turborepo-starter | turborepo | project:web+api | rule-based | READY |  |  | PASS | 223 |
| nrwl/nx-examples ⚠ tip≠pin | nx | angular | rule-based | FAILED | START_COMMAND_FAILED | start | UNSUPPORTED_BY_CONTRACT | 334 |

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
- message: Nothing is listening on port 4200. Sockets observed: 127.0.0.11:43559.
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

- plan: `pip install --prefer-binary -r requirements.txt` → `flask run --host=0.0.0.0 --port=5000` (python 3.11, port 5000, dir .)
- message: Dependency installation failed.
- evidence: `Failed to build multidict`
- repairs: ai:PLAN_REWRITE

### nsidnev/fastapi-realworld-example-app — BUILD_FAILED
**DEVLAUNCH_BUG** — Its rule plan was rewritten by the model this run (ai:PLAN_REWRITE), and the rewrite put `pip install -r /workspace/.devlaunch/requirements.txt` in the build step. DevLaunch writes that generated file only when the install command names it, so the build failed on `No such file`. The repository's own failure is unchanged underneath — asyncpg ^0.26 has no Python 3.12 wheel — but the run never reached it. Candidate fix: write the file when any step names it, or reject the path outside installCommand.

- plan: `pip install asyncpg==0.29.0` → `uvicorn app.main:application --host 0.0.0.0 --port 8000` (python 3.12, port 8000, dir .)
- message: Build step failed.
- evidence: `ERROR: Could not open requirements file: [Errno 2] No such file or directory: '/workspace/.devlaunch/requirements.txt'`
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
