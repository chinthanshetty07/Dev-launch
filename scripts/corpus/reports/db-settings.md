# Corpus report — db-settings

Backend `7007733` (stale: false), egress enforced, 2026-10-08T05:58:07.155Z.

**3 / 6 READY** (50%), 0 planned by the model, 2 with a model repair, 4 min total.

| Outcome | Count |
|---|---|
| FAIL | 3 |
| PASS | 3 |

### Failures by code

| Failure code | Count |
|---|---|
| PORT_NOT_LISTENING | 1 |
| MISSING_ENV | 1 |
| DEPENDENCY_INSTALL_FAILED | 1 |

### Failures by label

| Label | Count |
|---|---|
| UNLABELLED | 3 |

## Results

| Repository | Category | Detected | Plan | State | Code | Stage | Label | s |
|---|---|---|---|---|---|---|---|---|
| danielfsousa/express-rest-boilerplate | express | express | ai-fallback | FAILED | PORT_NOT_LISTENING | start | UNLABELLED | 42 |
| fastify/demo | fastify | fastify | rule-based | FAILED | MISSING_ENV | start | UNLABELLED | 72 |
| gothinkster/node-express-realworld-example-app | ts-node | express | rule-based | READY |  |  | PASS | 26 |
| sahat/hackathon-starter ⚠ tip≠pin | express | express | rule-based | READY |  |  | PASS | 36 |
| testdrivenio/fastapi-crud-sync | fastapi | fastapi | rule-based | READY |  |  | PASS | 28 |
| nsidnev/fastapi-realworld-example-app | poetry | fastapi | ai-fallback | FAILED | DEPENDENCY_INSTALL_FAILED | install | UNLABELLED | 18 |

## Evidence

### danielfsousa/express-rest-boilerplate — PORT_NOT_LISTENING
- plan: `yarn install --frozen-lockfile` → `yarn run dev` (node 20, port 3000, dir .)
- message: Nothing is listening on port 3000. Sockets observed: 127.0.0.11:43479.
- evidence: `missing: [`
- repairs: ai:PLAN_REWRITE
- configuration gate skipped, unset: EMAIL_PORT, EMAIL_HOST, EMAIL_USERNAME, EMAIL_PASSWORD

### fastify/demo — MISSING_ENV
- plan: `npm install --no-audit --no-fund` → `npm run dev` (node 20, port 3000, dir .)
- message: The start script loads .env with --env-file, and the repository has no such file.
- evidence: `node: .env: not found`

### nsidnev/fastapi-realworld-example-app — DEPENDENCY_INSTALL_FAILED
- plan: `pip install -r /workspace/.devlaunch/requirements.txt` → `uvicorn app.main:application --host 0.0.0.0 --port 8000` (python 3.11, port 8000, dir .)
- message: Dependency installation failed.
- evidence: `ERROR: Failed to build installable wheels for some pyproject.toml based projects (asyncpg)`
- repairs: ai:PLAN_REWRITE
