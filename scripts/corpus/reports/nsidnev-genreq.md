# Corpus report — nsidnev-genreq

Backend `4b53edb` (stale: false), egress enforced, 2026-10-01T10:38:19.632Z.

One repository, re-run on `4b53edb` (the generated requirements file is written for whichever step names it). Only one attempt launched: the rule plan, `pip install -r /workspace/.devlaunch/requirements.txt` on Python 3.12, which reached the repository's own failure — asyncpg ^0.26 builds no wheel for 3.12. The plan shown is the model's later rewrite (Python 3.11, requirements.txt); the session records no launch of it. No `Could not open requirements file` this time. The after4 plan shape, with the file used in the build step, did not recur live; it is covered by a real-Docker test.

**0 / 1 READY** (0%), 0 planned by the model, 1 with a model repair, 2 min total.

| Outcome | Count |
|---|---|
| FAIL | 1 |

### Failures by code

| Failure code | Count |
|---|---|
| DEPENDENCY_INSTALL_FAILED | 1 |

### Failures by label

| Label | Count |
|---|---|
| UNSUPPORTED_BY_CONTRACT | 1 |

## Results

| Repository | Category | Detected | Plan | State | Code | Stage | Label | s |
|---|---|---|---|---|---|---|---|---|
| nsidnev/fastapi-realworld-example-app | poetry | fastapi | ai-fallback | FAILED | DEPENDENCY_INSTALL_FAILED | install | UNSUPPORTED_BY_CONTRACT | 110 |

## Evidence

### nsidnev/fastapi-realworld-example-app — DEPENDENCY_INSTALL_FAILED
**UNSUPPORTED_BY_CONTRACT** — asyncpg ^0.26 has no Python 3.12 wheel and does not build; DevLaunch ships one Python. Reached by the rule plan now that the generated requirements file is written for every step that names it.

- plan: `pip install -r requirements.txt` → `uvicorn app.main:application --host 0.0.0.0 --port 8000` (python 3.11, port 8000, dir .)
- message: Dependency installation failed.
- evidence: `ERROR: Failed to build installable wheels for some pyproject.toml based projects (asyncpg)`
- repairs: ai:PLAN_REWRITE
