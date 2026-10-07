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
# Requires: colima running. The rules and the build cap are restored at every VM start by
# boot services this installs; they are lost only if the VM is deleted (colima delete).
set -euo pipefail

NETWORK_NAME="${DEVLAUNCH_NETWORK:-devlaunch-net}"
SUBNET="${DEVLAUNCH_SUBNET:-172.31.250.0/24}"
# Every network DevLaunch creates comes from this range: devlaunch-net above, and the one
# network each run gets so that two runs cannot reach each other. The rules below apply to
# the whole range, so each of those networks is under them from the moment it exists.
POOL="${DEVLAUNCH_NETWORK_POOL:-172.31.0.0/16}"
# Every Dockerfile build runs in this cgroup (Docker's --cgroup-parent), capped below, so a
# fork bomb in a build step stops at the cap instead of filling the VM's process table.
BUILD_CGROUP="${DEVLAUNCH_BUILD_CGROUP:-devlaunch-build}"
BUILD_PIDS_MAX="${DEVLAUNCH_BUILD_PIDS_MAX:-2048}"
BUILD_MEMORY_MAX_MB="${DEVLAUNCH_BUILD_MEMORY_MAX_MB:-4096}"

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
# Written to the VM and run by a boot service, as well as now: iptables rules live only in
# the running kernel, so a VM restart (colima stop/start, a Mac reboot) used to leave every
# container with no rules at all until this script was run again by hand.
cat > /usr/local/sbin/devlaunch-network-rules.sh <<'INNER'
#!/bin/sh
set -eu
POOL="${POOL}"

# Docker creates DOCKER-USER as it starts; at boot this runs after Docker, but wait a
# little in case its firewall setup is still going.
i=0
until iptables -L DOCKER-USER -n >/dev/null 2>&1; do
  i=\$((i + 1))
  [ \$i -gt 30 ] && { echo "DOCKER-USER chain never appeared" >&2; exit 1; }
  sleep 1
done

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
iptables -C DOCKER-USER -s "\$POOL" -j DEVLAUNCH 2>/dev/null \\
  || iptables -I DOCKER-USER 1 -s "\$POOL" -j DEVLAUNCH

# DOCKER-USER only sees *forwarded* traffic. A packet from a container to the VM itself
# — its own default gateway included — terminates locally and hits INPUT instead, so
# without this a container could still reach services listening on the VM host.
#
# Outbound internet traffic is unaffected: that is FORWARD plus POSTROUTING masquerade,
# never INPUT. Replies to published ports are preserved by the conntrack rule.
iptables -N DEVLAUNCH-IN 2>/dev/null || iptables -F DEVLAUNCH-IN
iptables -A DEVLAUNCH-IN -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
iptables -A DEVLAUNCH-IN -j DROP

iptables -C INPUT -s "\$POOL" -j DEVLAUNCH-IN 2>/dev/null \\
  || iptables -I INPUT 1 -s "\$POOL" -j DEVLAUNCH-IN

# Before the rules covered the whole range they matched devlaunch-net's /24 alone; that
# older jump is redundant now, so it goes.
while iptables -D DOCKER-USER -s 172.31.250.0/24 -j DEVLAUNCH 2>/dev/null; do :; done
while iptables -D INPUT -s 172.31.250.0/24 -j DEVLAUNCH-IN 2>/dev/null; do :; done
INNER
chmod 755 /usr/local/sbin/devlaunch-network-rules.sh
/usr/local/sbin/devlaunch-network-rules.sh

# After Docker, which sets up its own chains as it starts; part of Docker, so a restart
# of Docker alone runs this again too.
cat > /etc/systemd/system/devlaunch-network-rules.service <<'UNIT'
[Unit]
Description=DevLaunch: keep containers off the local network and the VM
After=docker.service
PartOf=docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/devlaunch-network-rules.sh
RemainAfterExit=yes

[Install]
WantedBy=docker.service
UNIT
systemctl daemon-reload
systemctl enable devlaunch-network-rules.service >/dev/null 2>&1

echo "    installed (forward):"
iptables -L DEVLAUNCH -n | sed 's/^/      /'
echo "    installed (input):"
iptables -L DEVLAUNCH-IN -n | sed 's/^/      /'
echo "    restored at every VM start by devlaunch-network-rules.service"
SCRIPT

echo "==> Capping Dockerfile builds at ${BUILD_PIDS_MAX} processes and ${BUILD_MEMORY_MAX_MB} MB"
colima ssh -- sudo sh -s <<SCRIPT
set -eu
# Written to the VM so it can be run again at boot: cgroups do not survive a restart.
cat > /usr/local/sbin/devlaunch-build-cgroup.sh <<'INNER'
#!/bin/sh
set -eu
root=/sys/fs/cgroup
dir=\$root/${BUILD_CGROUP}
mkdir -p "\$dir"
# The controllers must be on in the parent to limit anything in the child.
echo "+pids +memory +cpu" > "\$root/cgroup.subtree_control"
echo ${BUILD_PIDS_MAX} > "\$dir/pids.max"
echo \$(( ${BUILD_MEMORY_MAX_MB} * 1024 * 1024 )) > "\$dir/memory.max"
echo "+pids +memory +cpu" > "\$dir/cgroup.subtree_control"
INNER
chmod 755 /usr/local/sbin/devlaunch-build-cgroup.sh
/usr/local/sbin/devlaunch-build-cgroup.sh

cat > /etc/systemd/system/devlaunch-build-cgroup.service <<'UNIT'
[Unit]
Description=DevLaunch: process and memory cap for Dockerfile builds
Before=docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/devlaunch-build-cgroup.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable devlaunch-build-cgroup.service >/dev/null 2>&1
echo "    pids.max=\$(cat /sys/fs/cgroup/${BUILD_CGROUP}/pids.max) memory.max=\$(cat /sys/fs/cgroup/${BUILD_CGROUP}/memory.max)"
SCRIPT

if [ "${NETWORK_NAME}" = "devlaunch-net" ]; then
  echo "==> Done. The backend uses ${NETWORK_NAME} by default."
else
  echo "==> Done. Set DEVLAUNCH_NETWORK=${NETWORK_NAME} in .env for the backend to use it."
fi
