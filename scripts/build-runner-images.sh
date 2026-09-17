#!/usr/bin/env bash
# Build DevLaunch's allowlisted runner images.
#
# Built once, never per run. Keep the tags in sync with APPROVED_IMAGES in
# apps/backend/src/services/security/ImageAllowlist.ts — an image missing from the
# allowlist is refused before a container is ever created.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Building devlaunch/node:20"
docker build -f docker/runner/node20.Dockerfile -t devlaunch/node:20 docker/runner

echo "==> Building devlaunch/python:3.12"
docker build -f docker/runner/python312.Dockerfile -t devlaunch/python:3.12 docker/runner

echo "==> Done"
docker images --format '    {{.Repository}}:{{.Tag}}  {{.Size}}' \
  | grep -E 'devlaunch/(node|python)'
