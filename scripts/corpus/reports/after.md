# Corpus report — after

Backend `c68f255` (stale: false), egress enforced, 2026-09-29T09:06:16.360Z.

The code measured is `c68f255` plus fixes 1–10 of this session, uncommitted at the time: git tree `6581a05`. `stale: false` compares contents, so it describes that tree.

**30 / 40 READY** (75%), 2 planned by the model, 5 with a model repair, 31 min total.

| Outcome | Count |
|---|---|
| PASS | 30 |
| FAIL | 10 |

### Failures by code

| Failure code | Count |
|---|---|
| START_COMMAND_FAILED | 2 |
| DEPENDENCY_INSTALL_FAILED | 2 |
| UNSUPPORTED_PROJECT | 2 |
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
| mdn/todo-react | vite-react | vite | rule-based | READY |  |  | PASS | 19 |
| mdn/todo-vue | vite-vue | vite | rule-based | READY |  |  | PASS | 7 |
| jguerraco/svelte-vite-app | vite-svelte | vite | rule-based | READY |  |  | PASS | 6 |
| ChrisWongAtCUHK/svelte-vite-app | vite-svelte | vite | rule-based | READY |  |  | PASS | 58 |
| sveltejs/template | svelte-rollup | node | rule-based | READY |  |  | PASS | 10 |
| ahfarmer/calculator | cra | cra | rule-based | FAILED | START_COMMAND_FAILED | start | UNSUPPORTED_BY_CONTRACT | 54 |
| shadcn-ui/next-template | next | next | rule-based | READY |  |  | PASS | 39 |
| vercel/nextjs-portfolio-starter | next | next | rule-based | READY |  |  | PASS | 38 |
| nuxt/starter | nuxt | nuxt | rule-based | READY |  |  | PASS | 97 |
| sveltejs/realworld | sveltekit | sveltekit | rule-based | READY |  |  | PASS | 13 |
| onwidget/astrowind | astro | astro | rule-based | READY |  |  | PASS | 24 |
| remix-run/indie-stack | remix | remix | rule-based | READY |  |  | PASS | 214 |
| gothinkster/angular-realworld-example-app | angular | angular | rule-based | FAILED | PORT_NOT_LISTENING | start | UNSUPPORTED_BY_CONTRACT | 111 |
| developit/express-es6-rest-api | express | express | rule-based | READY |  |  | PASS | 28 |
| danielfsousa/express-rest-boilerplate | express | express | ai-fallback | READY |  |  | PASS | 94 |
| bradtraversy/react_express_starter | express | project:web+api | rule-based | READY |  |  | PASS | 53 |
| fastify/demo | fastify | fastify | rule-based | FAILED | MISSING_ENV | start | REPO_FAILURE | 40 |
| jellydn/fastify-starter | fastify | fastify | rule-based | READY |  |  | PASS | 12 |
| nestjs/typescript-starter | nestjs | nest | rule-based | READY |  |  | PASS | 10 |
| ljlm0402/typescript-express-starter | ts-node | node | rule-based | COMPLETED | (COMPLETED, no port) | readiness | REPO_FAILURE | 7 |
| gothinkster/node-express-realworld-example-app | ts-node | express | rule-based | READY |  |  | PASS | 21 |
| sahat/hackathon-starter | express | express | rule-based | READY |  |  | PASS | 21 |
| miguelgrinberg/microblog | flask | ai-fallback | ai-fallback | FAILED | DEPENDENCY_INSTALL_FAILED | install | UNSUPPORTED_BY_CONTRACT | 19 |
| JayBhatt2021/improved-flask-tutorial-app | flask | ai-fallback | ai-fallback | READY |  |  | PASS | 32 |
| testdrivenio/fastapi-crud-sync | fastapi | fastapi | rule-based | READY |  |  | PASS | 102 |
| max-pfeiffer/uvicorn-poetry-fastapi-project-template | poetry | fastapi | rule-based | FAILED | DEPENDENCY_INSTALL_FAILED | install | REPO_FAILURE | 5 |
| nsidnev/fastapi-realworld-example-app | poetry | fastapi | ai-fallback | FAILED | START_COMMAND_FAILED | start | UNSUPPORTED_BY_CONTRACT | 110 |
| mdn/django-locallibrary-tutorial | django | django | rule-based | READY |  |  | PASS | 10 |
| pyCampaDB/pipenvDjango | pipenv | django | rule-based | READY |  |  | PASS | 10 |
| streamlit/demo-uber-nyc-pickups | streamlit | streamlit | rule-based | READY |  |  | PASS | 17 |
| streamlit/streamlit-example | streamlit | streamlit | rule-based | READY |  |  | PASS | 14 |
| gogetjax/gradio-app-demo | gradio | gradio | rule-based | READY |  |  | PASS | 19 |
| TakanoriOnuma/bun-react-vite | bun | vite | rule-based | READY |  |  | PASS | 22 |
| sadrozzy/Bun-React-Template | bun | — | — | FAILED | UNSUPPORTED_PROJECT | clone | UNSUPPORTED_BY_CONTRACT | 3 |
| patelharsh9797/bun-hono-app | bun | — | — | FAILED | UNSUPPORTED_PROJECT | clone | UNSUPPORTED_BY_CONTRACT | 3 |
| dan5py/turborepo-shadcn-ui | turborepo | next | rule-based | READY |  |  | PASS | 15 |
| ejazahm3d/fullstack-turborepo-starter | turborepo | project:web+api | rule-based | READY |  |  | PASS | 180 |
| nrwl/nx-examples | nx | angular | ai-fallback | FAILED | OUT_OF_MEMORY | install | UNSUPPORTED_BY_CONTRACT | 295 |

## Evidence

### ahfarmer/calculator — START_COMMAND_FAILED
**UNSUPPORTED_BY_CONTRACT** — With CI=true the dev server now stays up and compiles — and webpack 4 (react-scripts 3) fails under Node >= 17's OpenSSL 3: ERR_OSSL_EVP_UNSUPPORTED. The usual fix, NODE_OPTIONS=--openssl-legacy-provider, is refused by the validator by design (NODE_OPTIONS can inject code), and Node 16 is not an approved image. The diagnosis is still generic (START_COMMAND_FAILED, and a model was asked); a specific signature is a candidate.

- plan: `yarn install` → `yarn run start` (node 20, port 3000, dir .)
- message: Start command exited with code 1.
- evidence: `code: 'ERR_OSSL_EVP_UNSUPPORTED'`

### gothinkster/angular-realworld-example-app — PORT_NOT_LISTENING
**UNSUPPORTED_BY_CONTRACT** — ng serve now starts, then cannot bundle realworld/assets/theme/styles.css: `realworld/` is a git submodule, and intake clones with --no-recurse-submodules by design. A .gitmodules warning before the run is a candidate.

- plan: `npm install --no-audit --no-fund` → `npm run start -- --host 0.0.0.0 --port 4200` (node 20, port 4200, dir .)
- message: Nothing is listening on port 4200. Sockets observed: 127.0.0.11:41565.
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

- plan: `pip install --prefer-binary --no-build-isolation -r requirements.txt` → `gunicorn -b 0.0.0.0:5000 microblog:app` (python 3.12, port 5000, dir .)
- message: Dependency installation failed.
- evidence: `ERROR: Failed to build installable wheels for some pyproject.toml based projects (multidict)`
- repairs: ai:PLAN_REWRITE

### max-pfeiffer/uvicorn-poetry-fastapi-project-template — DEPENDENCY_INSTALL_FAILED
**REPO_FAILURE** — A cookiecutter template; its pyproject.toml is not valid TOML until rendered.

- plan: `pip install .` → `uvicorn app.main:app --host 0.0.0.0 --port 8000` (python 3.12, port 8000, dir {{cookiecutter.project_slug}})
- message: Dependency installation failed.
- evidence: `tomllib.TOMLDecodeError: Invalid statement (at line 5, column 1)`

### nsidnev/fastapi-realworld-example-app — START_COMMAND_FAILED
**UNSUPPORTED_BY_CONTRACT** — Its poetry.lock pins asyncpg 0.26.0 and psycopg2-binary 2.9.3, neither with a Python 3.12 wheel, and its own caret ranges keep asyncpg below 0.27 — so a faithful install fails on 3.12 too. DevLaunch still installs Poetry dependencies with no constraints at all, which is why the report names pydantic 2 rather than the Python version: honouring the ranges needs `<`/`>` in a command or a generated requirements file, both decisions.

- plan: `pip install uvicorn fastapi pydantic==1.10.13 passlib pyjwt databases asyncpg psycopg2-binary aiosql pypika alembic python-slugify unidecode loguru` → `uvicorn app.main:application --host 0.0.0.0 --port 8000` (python 3.12, port 8000, dir .)
- message: Start command exited with code 1.
- evidence: `pydantic.errors.PydanticImportError: 'BaseSettings' has been moved to the 'pydantic-settings' package. See https://docs.pydantic.dev/2.13/migration/#basesettings-has-moved-to-pydantic-settings for more details.`
- repairs: ai:PLAN_REWRITE

### sadrozzy/Bun-React-Template — UNSUPPORTED_PROJECT
**UNSUPPORTED_BY_CONTRACT** — Its dev script is `bunx --bun vite`. Now declined in 3 seconds with the script named, and no model call.

- message: The `dev` script runs `bunx --bun vite`, which needs the Bun runtime. DevLaunch runs Node 20 and 22 and ships no Bun, so no plan it can make starts this project.

### patelharsh9797/bun-hono-app — UNSUPPORTED_PROJECT
**UNSUPPORTED_BY_CONTRACT** — Written for the Bun runtime. Now declined in 3 seconds with the script named, and no model call.

- message: The `dev` script runs `bun --watch server/index.ts`, which needs the Bun runtime. DevLaunch runs Node 20 and 22 and ships no Bun, so no plan it can make starts this project.

### nrwl/nx-examples — OUT_OF_MEMORY
**UNSUPPORTED_BY_CONTRACT** — A polyglot Nx workspace: its @nx/dotnet plugin needs a .NET toolchain, and fails without one on Node 22 and on Node 20 alike — measured outside DevLaunch, where the install also fit in 2955 MB. So its .node-version (22.2.0) is not what stops it. Under DevLaunch the install first hit the memory ceiling and then Nx failed with `WorkspaceContext is not a constructor`, which the looser experiment did not reproduce and which is not isolated.

- plan: `yarn install` → `yarn start` (node 20, port 4200, dir .)
- message: The process was killed for exceeding the container memory limit.
- evidence: `Killed`
- repairs: deterministic:MEMORY_LIMIT_RAISED, ai:PLAN_REWRITE
