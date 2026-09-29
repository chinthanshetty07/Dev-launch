# Corpus report — after2

Backend `17bef3c` (stale: false), egress enforced, 2026-09-29T11:19:32.149Z.

The code measured is `17bef3c` plus changes A–E of this session, uncommitted at the time: git tree `935728f`. "With a model repair" counts repairs that were *applied*; a model call whose plan the validator rejected is not counted, so it undercounts calls — microblog and nx-examples each passed through REPAIRING without one being recorded.

**30 / 40 READY** (75%), 2 planned by the model, 2 with a model repair, 33 min total.

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
| OUT_OF_MEMORY | 1 |

### Failures by label

| Label | Count |
|---|---|
| UNSUPPORTED_BY_CONTRACT | 7 |
| REPO_FAILURE | 3 |

## Results

| Repository | Category | Detected | Plan | State | Code | Stage | Label | s |
|---|---|---|---|---|---|---|---|---|
| mdn/beginner-html-site-styled | static | static | rule-based | READY |  |  | PASS | 4 |
| mdn/beginner-html-site-scripted | static | static | rule-based | READY |  |  | PASS | 4 |
| mdn/todo-react | vite-react | vite | rule-based | READY |  |  | PASS | 27 |
| mdn/todo-vue | vite-vue | vite | rule-based | READY |  |  | PASS | 7 |
| jguerraco/svelte-vite-app | vite-svelte | vite | rule-based | READY |  |  | PASS | 6 |
| ChrisWongAtCUHK/svelte-vite-app | vite-svelte | vite | rule-based | READY |  |  | PASS | 9 |
| sveltejs/template | svelte-rollup | node | rule-based | READY |  |  | PASS | 11 |
| ahfarmer/calculator | cra | cra | rule-based | FAILED | WRONG_RUNTIME_VERSION | start | UNSUPPORTED_BY_CONTRACT | 56 |
| shadcn-ui/next-template | next | next | rule-based | READY |  |  | PASS | 40 |
| vercel/nextjs-portfolio-starter | next | next | rule-based | READY |  |  | PASS | 51 |
| nuxt/starter | nuxt | nuxt | rule-based | READY |  |  | PASS | 105 |
| sveltejs/realworld | sveltekit | sveltekit | rule-based | READY |  |  | PASS | 16 |
| onwidget/astrowind | astro | astro | rule-based | READY |  |  | PASS | 31 |
| remix-run/indie-stack | remix | remix | rule-based | READY |  |  | PASS | 235 |
| gothinkster/angular-realworld-example-app | angular | angular | rule-based | FAILED | PORT_NOT_LISTENING | start | UNSUPPORTED_BY_CONTRACT | 112 |
| developit/express-es6-rest-api | express | express | rule-based | READY |  |  | PASS | 28 |
| danielfsousa/express-rest-boilerplate | express | express | ai-fallback | READY |  |  | PASS | 96 |
| bradtraversy/react_express_starter | express | project:web+api | rule-based | READY |  |  | PASS | 57 |
| fastify/demo | fastify | fastify | rule-based | FAILED | MISSING_ENV | start | REPO_FAILURE | 46 |
| jellydn/fastify-starter | fastify | fastify | rule-based | READY |  |  | PASS | 17 |
| nestjs/typescript-starter | nestjs | nest | rule-based | READY |  |  | PASS | 14 |
| ljlm0402/typescript-express-starter | ts-node | node | rule-based | COMPLETED | (COMPLETED, no port) | readiness | REPO_FAILURE | 10 |
| gothinkster/node-express-realworld-example-app | ts-node | express | rule-based | READY |  |  | PASS | 22 |
| sahat/hackathon-starter | express | express | rule-based | READY |  |  | PASS | 44 |
| miguelgrinberg/microblog | flask | ai-fallback | ai-fallback | FAILED | DEPENDENCY_INSTALL_FAILED | install | UNSUPPORTED_BY_CONTRACT | 24 |
| JayBhatt2021/improved-flask-tutorial-app | flask | ai-fallback | ai-fallback | READY |  |  | PASS | 15 |
| testdrivenio/fastapi-crud-sync | fastapi | fastapi | rule-based | READY |  |  | PASS | 104 |
| max-pfeiffer/uvicorn-poetry-fastapi-project-template | poetry | fastapi | rule-based | FAILED | DEPENDENCY_INSTALL_FAILED | install | REPO_FAILURE | 10 |
| nsidnev/fastapi-realworld-example-app | poetry | fastapi | ai-fallback | FAILED | DEPENDENCY_INSTALL_FAILED | install | UNSUPPORTED_BY_CONTRACT | 125 |
| mdn/django-locallibrary-tutorial | django | django | rule-based | READY |  |  | PASS | 11 |
| pyCampaDB/pipenvDjango | pipenv | django | rule-based | READY |  |  | PASS | 10 |
| streamlit/demo-uber-nyc-pickups | streamlit | streamlit | rule-based | READY |  |  | PASS | 22 |
| streamlit/streamlit-example | streamlit | streamlit | rule-based | READY |  |  | PASS | 17 |
| gogetjax/gradio-app-demo | gradio | gradio | rule-based | READY |  |  | PASS | 19 |
| TakanoriOnuma/bun-react-vite | bun | vite | rule-based | READY |  |  | PASS | 18 |
| sadrozzy/Bun-React-Template | bun | — | — | FAILED | UNSUPPORTED_PROJECT |  | UNSUPPORTED_BY_CONTRACT | 2 |
| patelharsh9797/bun-hono-app | bun | — | — | FAILED | UNSUPPORTED_PROJECT |  | UNSUPPORTED_BY_CONTRACT | 2 |
| dan5py/turborepo-shadcn-ui | turborepo | next | rule-based | READY |  |  | PASS | 22 |
| ejazahm3d/fullstack-turborepo-starter | turborepo | project:web+api | rule-based | READY |  |  | PASS | 206 |
| nrwl/nx-examples | nx | angular | rule-based | FAILED | OUT_OF_MEMORY | install | UNSUPPORTED_BY_CONTRACT | 333 |

## Evidence

### ahfarmer/calculator — WRONG_RUNTIME_VERSION
**UNSUPPORTED_BY_CONTRACT** — webpack 4 under OpenSSL 3 (Node >= 17). Now diagnosed as such — WRONG_RUNTIME_VERSION, runtime too new, remedy naming webpack 5 or Node 16 — with no retry on Node 22 and no model call.

- plan: `yarn install` → `yarn run start` (node 20, port 3000, dir .)
- message: The build tool uses a hash OpenSSL 3 no longer provides, so it cannot run on Node 17 or newer — and DevLaunch has no older Node.
- evidence: `code: 'ERR_OSSL_EVP_UNSUPPORTED'`

### gothinkster/angular-realworld-example-app — PORT_NOT_LISTENING
**UNSUPPORTED_BY_CONTRACT** — Bundles a stylesheet from the `realworld/` git submodule, which intake does not fetch by design. The plan now warns about it before the run; the failure itself still quotes esbuild.

- plan: `npm install --no-audit --no-fund` → `npm run start -- --host 0.0.0.0 --port 4200` (node 20, port 4200, dir .)
- message: Nothing is listening on port 4200. Sockets observed: 127.0.0.11:37351.
- evidence: `You can mark the path "realworld/assets/theme/styles.css" as external to exclude it from the bundle, which will remove this error and leave the unresolved path in the bundle.`

### fastify/demo — MISSING_ENV
**REPO_FAILURE** — Its dev script is `tsx --env-file=.env` and the repository ships only .env.example; its README tells a person to copy it. Now reported as MISSING_ENV naming .env, and MySQL is correctly reported ready.

- plan: `npm install --no-audit --no-fund` → `npm run dev` (node 20, port 3000, dir .)
- message: The start script loads .env with --env-file, and the repository has no such file.
- evidence: `node: .env: not found`
- configuration gate skipped, unset: COOKIE_SECRET

### ljlm0402/typescript-express-starter — (COMPLETED, no port)
**REPO_FAILURE** — A project-generator CLI, not an application. COMPLETED is the correct answer.

- plan: `pnpm install` → `pnpm run start` (node 20, port 3000, dir .)

### miguelgrinberg/microblog — DEPENDENCY_INSTALL_FAILED
**UNSUPPORTED_BY_CONTRACT** — Pins a multidict with no Python 3.12 wheel; DevLaunch ships one Python.

- plan: `pip install -r requirements.txt` → `flask run --host=0.0.0.0` (python 3.12, port 5000, dir .)
- message: Dependency installation failed.
- evidence: `ERROR: Failed to build installable wheels for some pyproject.toml based projects (multidict)`

### max-pfeiffer/uvicorn-poetry-fastapi-project-template — DEPENDENCY_INSTALL_FAILED
**REPO_FAILURE** — A cookiecutter template; its pyproject.toml is not valid TOML until rendered.

- plan: `pip install .` → `uvicorn app.main:app --host 0.0.0.0 --port 8000` (python 3.12, port 8000, dir {{cookiecutter.project_slug}})
- message: Dependency installation failed.
- evidence: `tomllib.TOMLDecodeError: Invalid statement (at line 5, column 1)`

### nsidnev/fastapi-realworld-example-app — DEPENDENCY_INSTALL_FAILED
**UNSUPPORTED_BY_CONTRACT** — Its declared ranges are now honoured, so it fails where it truly does: asyncpg ^0.26 has no Python 3.12 wheel and does not build. Still classified as a generic DEPENDENCY_INSTALL_FAILED, and a model was still asked — a specific signature for a C extension that will not build on 3.12 is the candidate.

- plan: `pip install --prefer-binary -r /workspace/.devlaunch/requirements.txt` → `uvicorn app.main:application --host 0.0.0.0 --port 8000` (python 3.12, port 8000, dir .)
- message: Dependency installation failed.
- evidence: `ERROR: Failed to build installable wheels for some pyproject.toml based projects (asyncpg)`
- repairs: ai:PLAN_REWRITE

### sadrozzy/Bun-React-Template — UNSUPPORTED_PROJECT
**UNSUPPORTED_BY_CONTRACT** — Its dev script is `bunx --bun vite`. Now declined in 3 seconds with the script named, and no model call.

- message: The `dev` script runs `bunx --bun vite`, which needs the Bun runtime. DevLaunch runs Node 20 and 22 and ships no Bun, so no plan it can make starts this project.

### patelharsh9797/bun-hono-app — UNSUPPORTED_PROJECT
**UNSUPPORTED_BY_CONTRACT** — Written for the Bun runtime. Now declined in 3 seconds with the script named, and no model call.

- message: The `dev` script runs `bun --watch server/index.ts`, which needs the Bun runtime. DevLaunch runs Node 20 and 22 and ships no Bun, so no plan it can make starts this project.

### nrwl/nx-examples — OUT_OF_MEMORY
**UNSUPPORTED_BY_CONTRACT** — A polyglot Nx workspace: its @nx/dotnet plugin needs a .NET toolchain, and fails without one on Node 22 and on Node 20 alike — measured outside DevLaunch, where the install also fit in 2955 MB. So its .node-version (22.2.0) is not what stops it. Under DevLaunch the install first hit the memory ceiling and then Nx failed with `WorkspaceContext is not a constructor`, which the looser experiment did not reproduce and which is not isolated.

- plan: `yarn install` → `yarn run start --host 0.0.0.0 --port 4200 --disable-host-check` (node 20, port 4200, dir .)
- message: The process was killed for exceeding the container memory limit.
- evidence: `Killed`
- repairs: deterministic:MEMORY_LIMIT_RAISED
