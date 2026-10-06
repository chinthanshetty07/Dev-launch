# Corpus report — after7

Backend `d4e4e60` (stale: false), egress enforced, 2026-10-06T12:11:25.237Z.

**22 / 30 READY** (73%), 0 planned by the model, 5 with a model repair, 27 min total.

| Outcome | Count |
|---|---|
| PASS | 22 |
| FAIL | 8 |

### Failures by code

| Failure code | Count |
|---|---|
| DEPENDENCY_INSTALL_FAILED | 3 |
| PORT_NOT_LISTENING | 2 |
| WRONG_RUNTIME_VERSION | 1 |
| MISSING_ENV | 1 |
| (COMPLETED, no port) | 1 |

### Failures by label

| Label | Count |
|---|---|
| UNLABELLED | 8 |

## Results

| Repository | Category | Detected | Plan | State | Code | Stage | Label | s |
|---|---|---|---|---|---|---|---|---|
| mdn/beginner-html-site-styled | static | static | rule-based | READY |  |  | PASS | 6 |
| mdn/beginner-html-site-scripted ⚠ tip≠pin | static | static | rule-based | READY |  |  | PASS | 5 |
| mdn/todo-react | vite-react | vite | rule-based | READY |  |  | PASS | 75 |
| mdn/todo-vue ⚠ tip≠pin | vite-vue | vite | rule-based | READY |  |  | PASS | 27 |
| jguerraco/svelte-vite-app | vite-svelte | vite | rule-based | READY |  |  | PASS | 11 |
| ChrisWongAtCUHK/svelte-vite-app | vite-svelte | vite | rule-based | READY |  |  | PASS | 22 |
| sveltejs/template | svelte-rollup | node | rule-based | READY |  |  | PASS | 13 |
| ahfarmer/calculator | cra | cra | rule-based | FAILED | WRONG_RUNTIME_VERSION | start | UNLABELLED | 86 |
| shadcn-ui/next-template | next | next | rule-based | READY |  |  | PASS | 46 |
| vercel/nextjs-portfolio-starter | next | next | rule-based | READY |  |  | PASS | 67 |
| nuxt/starter | nuxt | nuxt | rule-based | READY |  |  | PASS | 148 |
| sveltejs/realworld | sveltekit | sveltekit | rule-based | READY |  |  | PASS | 29 |
| onwidget/astrowind | astro | astro | rule-based | READY |  |  | PASS | 38 |
| remix-run/indie-stack | remix | remix | rule-based | READY |  |  | PASS | 351 |
| gothinkster/angular-realworld-example-app | angular | angular | ai-fallback | FAILED | PORT_NOT_LISTENING | start | UNLABELLED | 193 |
| developit/express-es6-rest-api | express | express | rule-based | READY |  |  | PASS | 37 |
| danielfsousa/express-rest-boilerplate | express | express | ai-fallback | FAILED | PORT_NOT_LISTENING | start | UNLABELLED | 36 |
| bradtraversy/react_express_starter | express | project:web+api | rule-based | READY |  |  | PASS | 98 |
| fastify/demo | fastify | fastify | rule-based | FAILED | MISSING_ENV | start | UNLABELLED | 68 |
| jellydn/fastify-starter | fastify | fastify | rule-based | READY |  |  | PASS | 32 |
| nestjs/typescript-starter | nestjs | nest | rule-based | READY |  |  | PASS | 26 |
| ljlm0402/typescript-express-starter | ts-node | node | rule-based | COMPLETED | (COMPLETED, no port) | readiness | UNLABELLED | 9 |
| gothinkster/node-express-realworld-example-app | ts-node | express | rule-based | READY |  |  | PASS | 30 |
| sahat/hackathon-starter ⚠ tip≠pin | express | express | rule-based | READY |  |  | PASS | 57 |
| miguelgrinberg/microblog | flask | flask | ai-fallback | FAILED | DEPENDENCY_INSTALL_FAILED | install | UNLABELLED | 26 |
| JayBhatt2021/improved-flask-tutorial-app | flask | flask | rule-based | READY |  |  | PASS | 14 |
| testdrivenio/fastapi-crud-sync | fastapi | fastapi | rule-based | READY |  |  | PASS | 16 |
| max-pfeiffer/uvicorn-poetry-fastapi-project-template | poetry | fastapi | ai-fallback | FAILED | DEPENDENCY_INSTALL_FAILED | install | UNLABELLED | 9 |
| nsidnev/fastapi-realworld-example-app | poetry | fastapi | ai-fallback | FAILED | DEPENDENCY_INSTALL_FAILED | install | UNLABELLED | 19 |
| mdn/django-locallibrary-tutorial ⚠ tip≠pin | django | django | rule-based | READY |  |  | PASS | 14 |

## Evidence

### ahfarmer/calculator — WRONG_RUNTIME_VERSION
- plan: `yarn install` → `yarn run start` (node 20, port 3000, dir .)
- message: The build tool uses a hash OpenSSL 3 no longer provides, so it cannot run on Node 17 or newer — and DevLaunch has no older Node.
- evidence: `code: 'ERR_OSSL_EVP_UNSUPPORTED'`
- repairs: deterministic:START_COMMAND_CORRECTION

### gothinkster/angular-realworld-example-app — PORT_NOT_LISTENING
- plan: `npm install --no-audit --no-fund` → `npx ng serve --host 0.0.0.0 --port 4200 --disable-host-check` (node 20, port 4200, dir .)
- message: Nothing is listening on port 4200. Sockets observed: 127.0.0.11:35107.
- evidence: `You can mark the path "realworld/assets/theme/styles.css" as external to exclude it from the bundle, which will remove this error and leave the unresolved path in the bundle.`
- repairs: ai:PLAN_REWRITE

### danielfsousa/express-rest-boilerplate — PORT_NOT_LISTENING
- plan: `yarn install --frozen-lockfile` → `yarn run dev` (node 20, port 3000, dir .)
- message: Nothing is listening on port 3000. Sockets observed: 127.0.0.11:37353.
- evidence: `missing: [`
- repairs: ai:PLAN_REWRITE
- configuration gate skipped, unset: EMAIL_PORT, EMAIL_HOST, EMAIL_USERNAME, EMAIL_PASSWORD

### fastify/demo — MISSING_ENV
- plan: `npm install --no-audit --no-fund` → `npm run dev` (node 20, port 3000, dir .)
- message: The start script loads .env with --env-file, and the repository has no such file.
- evidence: `node: .env: not found`

### ljlm0402/typescript-express-starter — (COMPLETED, no port)
- plan: `pnpm install --frozen-lockfile` → `pnpm run start` (node 20, port 3000, dir .)

### miguelgrinberg/microblog — DEPENDENCY_INSTALL_FAILED
- plan: `pip install -r requirements.txt` → `flask run --host=0.0.0.0 --port=5000` (python 3.11, port 5000, dir .)
- message: Dependency installation failed.
- evidence: `ERROR: Failed to build installable wheels for some pyproject.toml based projects (multidict)`
- repairs: ai:PLAN_REWRITE

### max-pfeiffer/uvicorn-poetry-fastapi-project-template — DEPENDENCY_INSTALL_FAILED
- plan: `pip install -r requirements.txt` → `uvicorn app.main:app --host 0.0.0.0 --port 8000` (python 3.12, port 8000, dir {{cookiecutter.project_slug}})
- message: Dependency installation failed.
- evidence: `tomllib.TOMLDecodeError: Invalid statement (at line 5, column 1)`
- repairs: ai:PLAN_REWRITE

### nsidnev/fastapi-realworld-example-app — DEPENDENCY_INSTALL_FAILED
- plan: `pip install -r /workspace/.devlaunch/requirements.txt` → `uvicorn app.main:application --host 0.0.0.0 --port 8000` (python 3.11, port 8000, dir .)
- message: Dependency installation failed.
- evidence: `ERROR: Failed to build installable wheels for some pyproject.toml based projects (asyncpg)`
- repairs: ai:PLAN_REWRITE
