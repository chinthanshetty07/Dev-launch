#!/usr/bin/env bash
#
# Install DevLaunch's sandbox on this machine's Docker engine: the protected network, and
# the guard container that keeps the network rules and the build process cap in place.
#
# Containers must reach package registries, so general egress stays open — restricting
# that would need a MITM proxy with a package allowlist, which is out of scope (see
# docs/limitations.md). What IS enforced is that untrusted code cannot reach the local
# network, cloud metadata endpoints or the Docker host, and that a Dockerfile build cannot
# start processes without limit.
#
# Works on any engine that runs Linux containers — Colima, Docker Desktop (macOS, Windows
# through WSL2), OrbStack, Docker Engine on Linux — because the work is done by a container
# (docker/guard) on the engine's own network, PID and cgroup namespaces, not by a VM-specific
# command. It is `--restart=always`, so the engine starts it again after every restart and
# it puts back what a restart erased. Re-running this script is safe.
set -euo pipefail
cd "$(dirname "$0")/.."

NETWORK_NAME="${DEVLAUNCH_NETWORK:-devlaunch-net}"
SUBNET="${DEVLAUNCH_SUBNET:-172.31.250.0/24}"
# Every network DevLaunch creates comes from this range: devlaunch-net above, and the one
# network each run gets so that two runs cannot reach each other.
POOL="${DEVLAUNCH_NETWORK_POOL:-172.31.0.0/16}"
BUILD_PIDS_MAX="${DEVLAUNCH_BUILD_PIDS_MAX:-2048}"
BUILD_MEMORY_MAX_MB="${DEVLAUNCH_BUILD_MEMORY_MAX_MB:-4096}"
GUARD=devlaunch-guard

docker info >/dev/null 2>&1 || { echo "Docker is not running. Start it, then run this again." >&2; exit 1; }

echo "==> Ensuring Docker network ${NETWORK_NAME} (${SUBNET})"
if docker network inspect "${NETWORK_NAME}" >/dev/null 2>&1; then
  echo "    network already exists"
else
  docker network create --driver bridge --subnet "${SUBNET}" "${NETWORK_NAME}" >/dev/null
  echo "    created"
fi

# How the engine places containers in cgroups decides how the build cap is set up.
DRIVER=$(docker info --format '{{.CgroupDriver}}')
echo "==> Building the guard (cgroup driver: ${DRIVER})"
docker build -q -t devlaunch/guard docker/guard >/dev/null

echo "==> Starting the guard: network rules for ${POOL}, builds capped at ${BUILD_PIDS_MAX} processes / ${BUILD_MEMORY_MAX_MB} MB"
docker rm -f "${GUARD}" >/dev/null 2>&1 || true
# Privileged, on the host's network, PID and cgroup namespaces: what changing the engine's
# firewall and cgroups takes. It runs DevLaunch's own script only and gets no Docker socket.
docker run -d --name "${GUARD}" --restart=always \
  --privileged --net=host --pid=host --cgroupns=host \
  --label com.devlaunch.guard=true \
  -e DEVLAUNCH_NETWORK_POOL="${POOL}" \
  -e DEVLAUNCH_CGROUP_DRIVER="${DRIVER}" \
  -e DEVLAUNCH_BUILD_PIDS_MAX="${BUILD_PIDS_MAX}" \
  -e DEVLAUNCH_BUILD_MEMORY_MAX_MB="${BUILD_MEMORY_MAX_MB}" \
  devlaunch/guard >/dev/null

for _ in $(seq 1 30); do
  if docker logs "${GUARD}" 2>&1 | grep -q ' applied$'; then
    docker logs "${GUARD}" 2>&1 | sed 's/^/    /'
    if [ "${NETWORK_NAME}" = "devlaunch-net" ]; then
      echo "==> Done. The rules and the cap come back by themselves after Docker restarts."
    else
      echo "==> Done. Set DEVLAUNCH_NETWORK=${NETWORK_NAME} in .env for the backend to use it."
    fi
    exit 0
  fi
  sleep 1
done
echo "! The guard did not report success. Its log:" >&2
docker logs "${GUARD}" 2>&1 | sed 's/^/    /' >&2
exit 1
