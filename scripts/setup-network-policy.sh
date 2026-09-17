#!/usr/bin/env bash
#
# Install DevLaunch's network egress policy.
#
# Containers must reach package registries, so general egress stays open — restricting
# that would need a MITM proxy with a package allowlist, which is out of scope (see
# docs/limitations.md). What IS enforced is that untrusted code cannot reach the local
# network or cloud metadata endpoints.
#
# The rules live in a dedicated DEVLAUNCH chain jumped to from DOCKER-USER, which Docker
# guarantees is consulted before its own FORWARD rules and preserved across restarts of
# individual containers. Re-running this script is safe.
#
# Requires: colima running. Rules live inside the VM and are lost if the VM is recreated.
set -euo pipefail

NETWORK_NAME="${DEVLAUNCH_NETWORK:-devlaunch-net}"
SUBNET="${DEVLAUNCH_SUBNET:-172.31.250.0/24}"

echo "==> Ensuring Docker network ${NETWORK_NAME} (${SUBNET})"
if docker network inspect "${NETWORK_NAME}" >/dev/null 2>&1; then
  echo "    network already exists"
else
  docker network create --driver bridge --subnet "${SUBNET}" "${NETWORK_NAME}"
  echo "    created"
fi

echo "==> Installing iptables policy inside the Colima VM"
colima ssh -- sudo sh -s <<SCRIPT
set -eu

# Idempotent: create the chain, or empty it if a previous run left rules behind.
iptables -N DEVLAUNCH 2>/dev/null || iptables -F DEVLAUNCH

# Replies to connections that were opened from outside must pass, or published ports
# stop working: the container's response travels back to the Docker gateway, which is
# itself inside a blocked range.
iptables -A DEVLAUNCH -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN

# Block container-initiated traffic to the local network and to link-local, which is
# where cloud metadata endpoints live.
iptables -A DEVLAUNCH -d 10.0.0.0/8      -j DROP
iptables -A DEVLAUNCH -d 172.16.0.0/12   -j DROP
iptables -A DEVLAUNCH -d 192.168.0.0/16  -j DROP
iptables -A DEVLAUNCH -d 169.254.0.0/16  -j DROP

# Anything else — the public internet, including package registries — is allowed.
iptables -A DEVLAUNCH -j RETURN

# Jump only for traffic *from* DevLaunch containers, so no other workload is affected.
iptables -C DOCKER-USER -s ${SUBNET} -j DEVLAUNCH 2>/dev/null \
  || iptables -I DOCKER-USER 1 -s ${SUBNET} -j DEVLAUNCH

# DOCKER-USER only sees *forwarded* traffic. A packet from a container to the VM itself
# — its own default gateway included — terminates locally and hits INPUT instead, so
# without this a container could still reach services listening on the VM host.
#
# Outbound internet traffic is unaffected: that is FORWARD plus POSTROUTING masquerade,
# never INPUT. Replies to published ports are preserved by the conntrack rule.
iptables -N DEVLAUNCH-IN 2>/dev/null || iptables -F DEVLAUNCH-IN
iptables -A DEVLAUNCH-IN -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
iptables -A DEVLAUNCH-IN -j DROP

iptables -C INPUT -s ${SUBNET} -j DEVLAUNCH-IN 2>/dev/null \
  || iptables -I INPUT 1 -s ${SUBNET} -j DEVLAUNCH-IN

echo "    installed (forward):"
iptables -L DEVLAUNCH -n | sed 's/^/      /'
echo "    installed (input):"
iptables -L DEVLAUNCH-IN -n | sed 's/^/      /'
SCRIPT

echo "==> Done. Set DEVLAUNCH_NETWORK=${NETWORK_NAME} for the backend to use it."
