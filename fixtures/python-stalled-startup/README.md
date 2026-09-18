# python-stalled-startup

A server that starts and never finishes starting.

Uvicorn opens its listening socket *after* the lifespan hook returns, so a hook that
blocks — waiting on a database or an external service that never answers — leaves a
container that is alive, healthy by every other measure, and listening on nothing.

It is worth a fixture because of what it prints: two INFO lines and then silence. No
traceback, no exit, nothing matching an error pattern. Reported by the symptom alone the
failure reads `Nothing is listening on port 8000. Sockets observed: 127.0.0.11:37497.`,
which is true and useless. The last line the application printed —
`INFO: Waiting for application startup.` — is the entire diagnosis.
