#!/usr/bin/env bash
# Once per codespace (or prebuild): install DevLaunch's packages, build its runner images and
# start its guard. Docker comes up in the background in a new codespace, so wait for it.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Waiting for Docker"
for _ in $(seq 1 90); do docker info >/dev/null 2>&1 && break; sleep 2; done
docker info >/dev/null 2>&1 || { echo "Docker did not start in this codespace." >&2; exit 1; }

corepack enable >/dev/null 2>&1 || sudo corepack enable
./devlaunch install
