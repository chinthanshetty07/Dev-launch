# Corpus report — after7b

Backend `d4e4e60` (stale: false), egress enforced, 2026-10-06T12:58:24.109Z.

**7 / 10 READY** (70%), 1 partially ready, 0 planned by the model, 1 with a model repair, 13 min total.

| Outcome | Count |
|---|---|
| PASS | 7 |
| FAIL | 2 |
| PARTIAL | 1 |

### Failures by code

| Failure code | Count |
|---|---|
| UNSUPPORTED_PROJECT | 1 |
| PORT_NOT_LISTENING | 1 |
| START_COMMAND_FAILED | 1 |

### Failures by label

| Label | Count |
|---|---|
| UNLABELLED | 3 |

## Results

| Repository | Category | Detected | Plan | State | Code | Stage | Label | s |
|---|---|---|---|---|---|---|---|---|
| pyCampaDB/pipenvDjango | pipenv | django | rule-based | READY |  |  | PASS | 13 |
| streamlit/demo-uber-nyc-pickups | streamlit | streamlit | rule-based | READY |  |  | PASS | 31 |
| streamlit/streamlit-example | streamlit | streamlit | rule-based | READY |  |  | PASS | 21 |
| gogetjax/gradio-app-demo | gradio | gradio | rule-based | READY |  |  | PASS | 20 |
| TakanoriOnuma/bun-react-vite | bun | vite | rule-based | READY |  |  | PASS | 26 |
| sadrozzy/Bun-React-Template | bun | — | — | FAILED | UNSUPPORTED_PROJECT | clone | UNLABELLED | 3 |
| patelharsh9797/bun-hono-app | bun | docker:compose | repo-docker | PARTIALLY_READY | PORT_NOT_LISTENING | start | UNLABELLED | 133 |
| dan5py/turborepo-shadcn-ui | turborepo | next | rule-based | READY |  |  | PASS | 27 |
| ejazahm3d/fullstack-turborepo-starter | turborepo | project:web+api | rule-based | READY |  |  | PASS | 137 |
| nrwl/nx-examples ⚠ tip≠pin | nx | angular | ai-fallback | FAILED | START_COMMAND_FAILED | start | UNLABELLED | 381 |

## Evidence

### sadrozzy/Bun-React-Template — UNSUPPORTED_PROJECT
- message: The `dev` script runs `bunx --bun vite`, which needs the Bun runtime. DevLaunch runs Node 20 and 22 and ships no Bun, so no plan it can make starts this project.

### patelharsh9797/bun-hono-app — PORT_NOT_LISTENING
- service api [api] FAILED PORT_NOT_LISTENING `(the image's own command)`
- service app [web] READY  `(the image's own command)`
- message: api: Nothing is listening on port 3000. Sockets observed: 127.0.0.11:43327.
- evidence: `ZodError: [`
- probe app http://localhost:35000/ → 200

### nrwl/nx-examples — START_COMMAND_FAILED
- plan: `yarn install --immutable` → `yarn run serve --host 0.0.0.0 --port 4200` (node 20, port 4200, dir .)
- message: Start command exited with code 1.
- evidence: `TypeError: WorkspaceContext is not a constructor`
- repairs: ai:PLAN_REWRITE
