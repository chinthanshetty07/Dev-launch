#!/usr/bin/env bash
# Build DevLaunch's allowlisted runner images.
#
# Built once, never per run. Keep the tags in sync with APPROVED_IMAGES in
# apps/backend/src/services/security/ImageAllowlist.ts — an image missing from the
# allowlist is refused before a container is ever created.
set -euo pipefail
cd "$(dirname "$0")/.."

# Two Node versions, and the reason is a repository rather than a preference: `node:sqlite`
# arrived in 22.5, so a project importing it cannot run on 20 at all. Everything else
# about the two images is identical, which is why there is one Dockerfile.
for v in 20 22; do
  echo "==> Building devlaunch/node:$v"
  docker build --build-arg "NODE_VERSION=$v" -f docker/runner/node.Dockerfile -t "devlaunch/node:$v" docker/runner
done

# Two Python versions, for the same reason: a project that requires 3.13 cannot install a
# single dependency on 3.12.
for v in 3.12 3.13; do
  echo "==> Building devlaunch/python:$v"
  docker build --build-arg "PYTHON_VERSION=$v" -f docker/runner/python.Dockerfile -t "devlaunch/python:$v" docker/runner
done

echo "==> Done"
docker images --format '    {{.Repository}}:{{.Tag}}  {{.Size}}' \
  | grep -E 'devlaunch/(node|python)'
