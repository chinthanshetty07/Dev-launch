#!/usr/bin/env bash
# Every start of the codespace: Docker, then DevLaunch, in the background, with its log in
# /tmp/devlaunch.log. The dashboard opens in the browser once port 3939 answers.
set -uo pipefail
cd "$(dirname "$0")/.."

for _ in $(seq 1 90); do docker info >/dev/null 2>&1 && break; sleep 2; done
if ! docker info >/dev/null 2>&1; then
  echo "Docker did not start in this codespace. Try: Codespaces menu → Rebuild container." >&2
  exit 1
fi

# The guard is restart-always, but a codespace's Docker can come back without it.
docker inspect devlaunch-guard >/dev/null 2>&1 || bash scripts/setup-network-policy.sh

# Already running (a reconnect, not a restart): nothing to do.
curl -sf http://127.0.0.1:3939/api/health >/dev/null 2>&1 && exit 0

# Its own session (setsid): Codespaces stops what a start command leaves running in the
# background when the command ends, which a plain `&` does not escape.
setsid nohup ./devlaunch start > /tmp/devlaunch.log 2>&1 < /dev/null &
for _ in $(seq 1 120); do
  curl -sf http://127.0.0.1:3939/api/health >/dev/null 2>&1 && { echo "DevLaunch is running. The dashboard opens in your browser."; exit 0; }
  sleep 2
done
echo "DevLaunch did not start. Its log:" >&2
tail -40 /tmp/devlaunch.log >&2
node scripts/doctor.mjs >&2 || true
exit 1
