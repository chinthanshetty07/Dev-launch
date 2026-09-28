#!/usr/bin/env bash
# Assert the load-bearing claims of docs/production-readiness.md still hold.
#
# Derived from `.claude/tasks/2026-09-28-production-readiness/requirements.md`, not from
# the report — a check written from the thing it checks passes by construction.
#
# Every assertion here corresponds to a finding that would change if the claim stopped
# being true. Each one can go red; the comment on each says how.
#
# Exit 0 = the report is still accurate. Exit 1 = something it asserts has changed.
set -uo pipefail
cd "$(dirname "$0")/.."

pass=0 fail=0 open_findings=0
ok()   { printf '  ok    %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  FAIL  %s\n     -> %s\n' "$1" "$2"; fail=$((fail+1)); }
skip() { printf '  skip  %s (%s)\n' "$1" "$2"; }

echo "== R8: the machine is left as it was =="
# Goes red when a session leaks a container, which teardown has regressed on before.
n=$(docker ps -a --filter label=com.devlaunch.managed -q 2>/dev/null | wc -l | tr -d ' ')
[ "${n:-0}" = "0" ] && ok "no managed containers" || bad "no managed containers" "$n left behind"

echo "== R5: secrets have never been committed =="
# Goes red the moment a key is committed. The repo has a public remote.
n=$(git log -S 'gsk_' --oneline 2>/dev/null | wc -l | tr -d ' ')
[ "$n" = "0" ] && ok "no API key in git history" || bad "no API key in git history" "$n commit(s) touch one"
git check-ignore -q .env && ok ".env is ignored" || bad ".env is ignored" "it is not"

echo "== F1: what the API binds to =="
# The report's highest finding. Goes red in the direction we WANT: if someone fixes the
# bind, this says so rather than failing, because the report would then be out of date.
line=$(lsof -nP -iTCP:3939 -sTCP:LISTEN 2>/dev/null | tail -1 || true)
if [ -z "$line" ]; then
  skip "bind address" "nothing listening on 3939"
elif printf '%s' "$line" | grep -q 'TCP \*:3939'; then
  # The report says F1 is open. Finding it still open means the report is accurate, so
  # this is not a failure *of this script* — it is a failure of the system, surfaced at
  # the end. Conflating the two made the script red for telling the truth.
  ok "bind address matches the report (F1 still open: binds all interfaces)"
  open_findings=$((open_findings+1))
else
  bad "report is out of date" "the API no longer binds all interfaces; F1 is fixed, update docs/production-readiness.md"
fi

echo "== F3: the egress policy is installed =="
# Goes red after a `colima restart`, which is exactly how it was found missing.
if command -v colima >/dev/null 2>&1 && colima status >/dev/null 2>&1; then
  if colima ssh -- sudo iptables -S DOCKER-USER 2>/dev/null | grep -q 'DEVLAUNCH'; then
    ok "DOCKER-USER carries the DevLaunch rule"
  else
    bad "DOCKER-USER carries the DevLaunch rule" "chain is empty; run scripts/setup-network-policy.sh"
  fi
else
  skip "egress policy" "colima not running"
fi

echo "== R5: intake rejects what it says it rejects =="
# Goes red if GitManager's URL validation is loosened.
# The host check is a template literal — `Only ${config.intake.allowedHost} is
# supported` — so grepping for the *rendered* message found nothing and failed a check
# that was working. Assert the mechanism, which is what is actually in the source.
for pair in "host-allowlist:config.intake.allowedHost" \
            "credentials:URLs carrying credentials are rejected" \
            "http-scheme:Only https:// is supported" \
            "ssh:SSH-style URLs are not supported"; do
  needle=${pair#*:}
  grep -qF "$needle" apps/backend/src/services/git/GitManager.ts \
    && ok "rejects ${pair%%:*}" \
    || bad "rejects ${pair%%:*}" "check gone from GitManager.ts"
done
grep -qE "allowedHost:.*'github\.com'" apps/backend/src/config/index.ts \
  && ok "the allowed host is github.com" \
  || bad "the allowed host is github.com" "intake.allowedHost changed"

echo "== R5: the container grants the report inspected =="
# Goes red if a hardening flag is dropped. Checked at the source of truth for what is
# *sent* to Docker; the report additionally verified these on a live container.
for flag in "ReadonlyRootfs: true" "CapDrop: ['ALL']" "no-new-privileges" "Privileged: false"; do
  grep -qF "$flag" apps/backend/src/services/docker/ContainerSecurity.ts \
    && ok "$flag" || bad "$flag" "no longer set"
done
grep -q "docker.sock" apps/backend/src/services/docker/ContainerSecurity.ts \
  && bad "docker socket never mounted" "ContainerSecurity now references it" \
  || ok "docker socket never mounted"

echo "== R3: the suite still passes =="
# Unit only: the full suite needs exclusive Docker access and six minutes.
if [ "${SKIP_TESTS:-}" = "1" ]; then
  skip "unit suites" "SKIP_TESTS=1"
else
  out=$(cd apps/backend && ./node_modules/.bin/vitest run --exclude '**/integration/**' 2>&1 | grep -E '^ *Tests ' | tail -1)
  printf '%s' "$out" | grep -q 'failed' && bad "backend unit suite" "$out" || ok "backend unit suite ($(printf '%s' "$out" | tr -s ' '))"
  out=$(cd apps/frontend && ./node_modules/.bin/vitest run 2>&1 | grep -E '^ *Tests ' | tail -1)
  printf '%s' "$out" | grep -q 'failed' && bad "frontend suite" "$out" || ok "frontend suite ($(printf '%s' "$out" | tr -s ' '))"
fi

echo
echo "passed: $pass   failed: $fail   open findings: $open_findings"
if [ "$open_findings" -gt 0 ]; then
  echo
  echo "NOTE: $open_findings finding(s) from docs/production-readiness.md are still open."
  echo "      This script asserts the report is ACCURATE, not that the findings are fixed."
  echo "      To use it as a CI gate that blocks on open findings, run with STRICT=1."
  [ "${STRICT:-}" = "1" ] && exit 1
fi
[ "$fail" -eq 0 ]
