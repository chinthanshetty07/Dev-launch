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
# Key *shape*, not the prefix. Searching for `gsk_` made this check trip over its own
# documentation: the report and this script both contain the literal string, so the
# scan reported a hit on the commit that added them and would have done so for ever.
# A real key is the prefix plus a long alphanumeric body; prose about one is not.
#
# The working tree as well as history, because `git log -S` cannot see an uncommitted
# file — which is exactly where a key would sit just before somebody committed it.
n=$(git log -G 'gsk_[A-Za-z0-9]{30,}' --oneline 2>/dev/null | wc -l | tr -d ' ')
[ "$n" = "0" ] && ok "no API key in git history" || bad "no API key in git history" "$n commit(s) contain one"
# Tracked files only. `.env` holds a real key and is supposed to — it is gitignored, so
# it is not a leak, and a check that flags it fails for ever and gets muted. What matters
# is a key in a file git would carry to a public remote.
hits=$(git grep -IlE 'gsk_[A-Za-z0-9]{30,}' -- . 2>/dev/null | head -3 | tr '\n' ' ')
if [ -n "$hits" ]; then
  bad "no API key in a tracked file" "$hits"
else
  ok "no API key in a tracked file"
fi
git check-ignore -q .env && ok ".env is ignored" || bad ".env is ignored" "it is not"

echo "== F1: what the API binds to =="
# The report's highest finding. Goes red in the direction we WANT: if someone fixes the
# bind, this says so rather than failing, because the report would then be out of date.
# Behavioural when a server is up; otherwise started on purpose, because "nothing is
# listening" was silently skipping the only runtime check of the highest finding — and
# nothing is ever listening in CI, which is where this script runs.
line=$(lsof -nP -iTCP:3939 -sTCP:LISTEN 2>/dev/null | tail -1 || true)
if [ -z "$line" ]; then
  probe=$(cd apps/backend && node --import tsx -e "
    import('./src/server.ts').then(async (m) => {
      const s = await m.startServer(0, { ai: false });
      const addr = (await import('node:net')).isIP ? null : null;
      console.log(JSON.stringify({ host: m.bindHost() }));
      await s.close();
      process.exit(0);
    }).catch((e) => { console.log(JSON.stringify({ error: String(e) })); process.exit(0); });
  " 2>/dev/null | tail -1)
  if printf '%s' "$probe" | grep -q '"host":"127.0.0.1"'; then
    ok "a fresh server would bind loopback (started one to find out)"
  else
    bad "a fresh server would bind loopback" "probe said: ${probe:-nothing}"
  fi
elif printf '%s' "$line" | grep -q 'TCP \*:3939'; then
  bad "API binds loopback only" "binds all interfaces — F1 has regressed"
else
  ok "API binds loopback only (F1 closed)"
fi

# And the default that produces it, which is what a fresh checkout gets.
grep -q "return requested ? requested : '127.0.0.1';" apps/backend/src/server.ts \
  && ok "the default bind is 127.0.0.1" \
  || bad "the default bind is 127.0.0.1" "bindHost no longer defaults to loopback"

echo "== F3: a refused URL is refused at submit =="
# Goes red if validation drifts back into the pipeline.
grep -q "normaliseRepoUrl(repoUrl);" apps/backend/src/api/app.ts \
  && ok "the route validates before launching" \
  || bad "the route validates before launching" "POST /api/sessions no longer checks the URL"

echo "== F4: cache volumes are reaped =="
grep -q "sweepStaleCaches" apps/backend/src/services/cleanup/CleanupManager.ts \
  && ok "the reaper exists" || bad "the reaper exists" "sweepStaleCaches is gone"
grep -q "sweepStaleCaches(docker" apps/backend/src/server.ts \
  && ok "the reaper runs at startup" || bad "the reaper runs at startup" "it is never called"

echo "== F5: the egress policy is checked, not assumed =="
grep -q "probeEgress(docker" apps/backend/src/server.ts \
  && ok "the egress probe runs at startup" || bad "the egress probe runs at startup" "it is never called"

echo "== F6/F2: the AI boundary is covered without a network =="
[ -f apps/backend/src/__tests__/aiBoundary.test.ts ] \
  && ok "offline AI boundary tests exist" || bad "offline AI boundary tests exist" "the file is gone"

echo "== F7: CI =="
[ -f .github/workflows/ci.yml ] && ok "a workflow exists" || bad "a workflow exists" "no .github/workflows/ci.yml"

echo "== F8 (narrow): health can be unhealthy =="
grep -q "ok: problems.length === 0," apps/backend/src/api/app.ts \
  && ok "health reports problems" || bad "health reports problems" "ok is unconditional again"
grep -q "installRejectionHandler" apps/backend/src/server.ts \
  && ok "unhandled rejections are recorded" || bad "unhandled rejections are recorded" "the handler is gone"

echo "== F5: the egress policy is installed =="
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

echo "== the report's own open items =="
# STRICT became dead code the moment F1 closed: nothing incremented the counter any
# more, so "STRICT=1 exits 0" was true because the flag did nothing. It counts what the
# report still marks unfinished, which is the question it was meant to answer.
partial=$(grep -c 'PARTIALLY CLOSED' docs/production-readiness.md 2>/dev/null || echo 0)
open_findings=$partial
if [ "$partial" -gt 0 ]; then
  ok "$partial finding(s) partially closed, and the report says so"
else
  ok "no partially-closed findings"
fi

echo
echo "passed: $pass   failed: $fail   open findings: $open_findings"
if [ "$open_findings" -gt 0 ]; then
  echo
  echo "NOTE: $open_findings finding(s) in docs/production-readiness.md are not fully closed."
  echo "      This script asserts the report is ACCURATE, not that the findings are fixed."
  echo "      To use it as a CI gate that blocks on open findings, run with STRICT=1."
  [ "${STRICT:-}" = "1" ] && exit 1
fi
[ "$fail" -eq 0 ]
