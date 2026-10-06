# docker-go-api

A Go web server. DevLaunch has no Go runtime of its own, so it runs this from the
repository's own Dockerfile (the fallback). Proves: build in the sandbox, run under the
balanced profile, READY only after the end-to-end check.
