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

echo "==> Building devlaunch/python:3.12"
docker build -f docker/runner/python312.Dockerfile -t devlaunch/python:3.12 docker/runner

echo "==> Done"
docker images --format '    {{.Repository}}:{{.Tag}}  {{.Size}}' \
  | grep -E 'devlaunch/(node|python)'
