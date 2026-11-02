#!/bin/sh
# DevLaunch's diesel migration runner, for Postgres: what `diesel migration run` does, without
# compiling diesel_cli first (minutes, every run). Applies migrations/*/up.sql in name order,
# each in a transaction, recording each version in diesel's own table so the project's own
# tooling agrees with what ran. Reads DATABASE_URL; touches nothing else.
set -eu
dir="${1:-migrations}"
[ -d "$dir" ] || { echo "[devlaunch] no $dir folder; nothing to migrate"; exit 0; }
: "${DATABASE_URL:?DATABASE_URL is not set}"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c 'CREATE TABLE IF NOT EXISTS __diesel_schema_migrations (version VARCHAR(50) PRIMARY KEY NOT NULL, run_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)'
for m in $(ls -1 "$dir" | sort); do
  [ -f "$dir/$m/up.sql" ] || continue
  version=$(printf '%s' "${m%%_*}" | tr -d -- '-')
  done_already=$(psql "$DATABASE_URL" -tAq -c "SELECT 1 FROM __diesel_schema_migrations WHERE version = '$version'")
  if [ "$done_already" = "1" ]; then continue; fi
  echo "[devlaunch] applying migration $m"
  { echo 'BEGIN;'; cat "$dir/$m/up.sql"; echo; echo "INSERT INTO __diesel_schema_migrations (version) VALUES ('$version');"; echo 'COMMIT;'; } \
    | psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q
done
echo "[devlaunch] migrations applied"
