# python-slow-install

An install that takes longer than the readiness budget, then an application that starts
normally. Readiness used to begin counting when the *container* started, so a project
with a heavy dependency tree was reported as `PORT_NOT_LISTENING` before it had been
asked to listen — and then "repaired", re-running the whole install from scratch.

The delay is simulated with `sleep` so the fixture needs no network and takes the same
time on every machine.
