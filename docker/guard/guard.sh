#!/bin/sh
# DevLaunch guard. Runs as a restart-always container on the Docker host's network, PID and
# cgroup namespaces, so it can set what DevLaunch's sandbox depends on, and put it back:
#
#   - iptables rules that stop containers on DevLaunch's networks (POOL) reaching the local
#     network, cloud metadata or the Docker host itself, while the internet stays open;
#   - a cgroup that caps every Dockerfile build at a number of processes and an amount of
#     memory (Docker's classic builder takes no process limit of its own).
#
# Both live only in the running kernel, so they vanish when the engine's VM or the machine
# restarts. Docker starts restart-always containers when it starts, which brings this back,
# and the loop below re-checks every INTERVAL seconds in case anything removed them.
set -u

POOL="${DEVLAUNCH_NETWORK_POOL:-172.31.0.0/16}"
CGROUP_DRIVER="${DEVLAUNCH_CGROUP_DRIVER:-cgroupfs}"
BUILD_CGROUP="${DEVLAUNCH_BUILD_CGROUP:-devlaunch-build}"
BUILD_SLICE="${DEVLAUNCH_BUILD_SLICE:-devlaunchbuild.slice}"
PIDS_MAX="${DEVLAUNCH_BUILD_PIDS_MAX:-2048}"
MEMORY_MAX_MB="${DEVLAUNCH_BUILD_MEMORY_MAX_MB:-4096}"
INTERVAL="${DEVLAUNCH_GUARD_INTERVAL:-20}"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

# The iptables that holds Docker's own chains: nft on most current systems, legacy on some.
# Rules added to the other one would be silently ignored.
pick_iptables() {
  for ipt in iptables-nft iptables-legacy; do
    if $ipt -S DOCKER-USER >/dev/null 2>&1; then echo "$ipt"; return 0; fi
  done
  return 1
}

# The rules, as `iptables -S` prints them, so "already right" is a plain text comparison and
# the chains are only rebuilt when something differs — never emptied while they are correct.
expected_forward() {
  cat <<RULES
-N DEVLAUNCH
-A DEVLAUNCH -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN
-A DEVLAUNCH -d 10.0.0.0/8 -j DROP
-A DEVLAUNCH -d 172.16.0.0/12 -j DROP
-A DEVLAUNCH -d 192.168.0.0/16 -j DROP
-A DEVLAUNCH -d 169.254.0.0/16 -j DROP
-A DEVLAUNCH -j RETURN
RULES
}
expected_input() {
  cat <<RULES
-N DEVLAUNCH-IN
-A DEVLAUNCH-IN -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN
-A DEVLAUNCH-IN -j DROP
RULES
}

build_forward() {
  $IPT -N DEVLAUNCH 2>/dev/null || $IPT -F DEVLAUNCH
  # Replies to connections opened from outside (published ports) must pass.
  $IPT -A DEVLAUNCH -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  # The local network, and link-local, where cloud metadata lives.
  $IPT -A DEVLAUNCH -d 10.0.0.0/8 -j DROP
  $IPT -A DEVLAUNCH -d 172.16.0.0/12 -j DROP
  $IPT -A DEVLAUNCH -d 192.168.0.0/16 -j DROP
  $IPT -A DEVLAUNCH -d 169.254.0.0/16 -j DROP
  # Everything else — the internet, package registries included — is allowed.
  $IPT -A DEVLAUNCH -j RETURN
}
build_input() {
  # DOCKER-USER sees only forwarded traffic; a packet to the Docker host itself (the
  # network's own gateway included) arrives on INPUT instead.
  $IPT -N DEVLAUNCH-IN 2>/dev/null || $IPT -F DEVLAUNCH-IN
  $IPT -A DEVLAUNCH-IN -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  $IPT -A DEVLAUNCH-IN -j DROP
}

apply_rules() {
  IPT=$(pick_iptables) || { log "waiting: Docker's DOCKER-USER chain is not there yet"; return 1; }
  changed=""
  if [ "$($IPT -S DEVLAUNCH 2>/dev/null)" != "$(expected_forward)" ]; then build_forward; changed="$changed forward"; fi
  if [ "$($IPT -S DEVLAUNCH-IN 2>/dev/null)" != "$(expected_input)" ]; then build_input; changed="$changed input"; fi
  # Only traffic *from* DevLaunch's networks is sent through the chains; no other container
  # on this machine is affected.
  if ! $IPT -C DOCKER-USER -s "$POOL" -j DEVLAUNCH 2>/dev/null; then
    $IPT -I DOCKER-USER 1 -s "$POOL" -j DEVLAUNCH && changed="$changed forward-jump"
  fi
  if ! $IPT -C INPUT -s "$POOL" -j DEVLAUNCH-IN 2>/dev/null; then
    $IPT -I INPUT 1 -s "$POOL" -j DEVLAUNCH-IN && changed="$changed input-jump"
  fi
  [ -n "$changed" ] && log "rules applied ($IPT):$changed"
  return 0
}

apply_cap() {
  mem=$((MEMORY_MAX_MB * 1024 * 1024))
  if [ "$CGROUP_DRIVER" = "systemd" ]; then
    # Docker's systemd driver takes a slice as the parent; systemd owns its limits. Enter
    # the host's namespaces to ask it. set-property also persists across reboots.
    host() { nsenter -t 1 -m -u -i -n -p -- "$@"; }
    if [ "$(host systemctl show "$BUILD_SLICE" -p TasksMax --value 2>/dev/null)" != "$PIDS_MAX" ]; then
      host systemctl set-property "$BUILD_SLICE" TasksMax="$PIDS_MAX" MemoryMax="$mem" >/dev/null 2>&1 \
        && log "build cap set on $BUILD_SLICE"
    fi
    # Active, so its cgroup exists and DevLaunch can read the cap before a build.
    host systemctl start "$BUILD_SLICE" >/dev/null 2>&1
    return 0
  fi
  root=/sys/fs/cgroup
  dir="$root/$BUILD_CGROUP"
  mkdir -p "$dir" || return 1
  # Controllers must be on in the parent to limit anything in the child.
  grep -qw pids "$root/cgroup.subtree_control" 2>/dev/null || echo "+pids +memory +cpu" > "$root/cgroup.subtree_control"
  if [ "$(cat "$dir/pids.max")" != "$PIDS_MAX" ]; then
    echo "$PIDS_MAX" > "$dir/pids.max" && echo "$mem" > "$dir/memory.max" && log "build cap set on $dir"
  fi
  grep -qw pids "$dir/cgroup.subtree_control" 2>/dev/null || echo "+pids +memory +cpu" > "$dir/cgroup.subtree_control"
  return 0
}

# `devlaunch-guard remove`: take everything above back out (./devlaunch uninstall).
remove_all() {
  # Only the iptables Docker uses: even listing with the other one can create its tables.
  for ipt in $(pick_iptables); do
    while $ipt -D DOCKER-USER -s "$POOL" -j DEVLAUNCH 2>/dev/null; do :; done
    while $ipt -D INPUT -s "$POOL" -j DEVLAUNCH-IN 2>/dev/null; do :; done
    $ipt -F DEVLAUNCH 2>/dev/null && $ipt -X DEVLAUNCH 2>/dev/null
    $ipt -F DEVLAUNCH-IN 2>/dev/null && $ipt -X DEVLAUNCH-IN 2>/dev/null
  done
  if [ "$CGROUP_DRIVER" = "systemd" ]; then
    nsenter -t 1 -m -u -i -n -p -- systemctl stop "$BUILD_SLICE" >/dev/null 2>&1
    nsenter -t 1 -m -u -i -n -p -- systemctl revert "$BUILD_SLICE" >/dev/null 2>&1
  else
    rmdir "/sys/fs/cgroup/$BUILD_CGROUP" 2>/dev/null
  fi
  log "removed"
}
if [ "${1:-}" = "remove" ]; then remove_all; exit 0; fi

log "starting: pool $POOL, cgroup driver $CGROUP_DRIVER, cap $PIDS_MAX processes / $MEMORY_MAX_MB MB"
first=1
while :; do
  ok=1
  apply_rules || ok=0
  apply_cap || { ok=0; log "could not set the build cap"; }
  if [ "$first" = 1 ] && [ "$ok" = 1 ]; then log "applied"; first=0; fi
  sleep "$INTERVAL"
done
