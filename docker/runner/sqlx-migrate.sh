#!/bin/sh
# DevLaunch's sqlx migration runner, for Postgres: what `sqlx migrate run` does, without
# compiling sqlx-cli first. Run before the build, because sqlx's query macros check every
# query against the database while compiling, so the tables have to exist by then
# (`launchbadge/realworld-axum-sqlx`, whose app migrates only once it is running).
#
# Each migration is recorded in sqlx's own table, with sqlx's own checksum (SHA-384 of the
# file), so the application's `sqlx::migrate!()` finds them applied and unchanged, and runs
# nothing twice. Applies `<version>_<name>.sql`, or the `.up.sql` of a reversible pair.
set -eu
dir="${1:-migrations}"
[ -d "$dir" ] || { echo "[devlaunch] no $dir folder; nothing to migrate"; exit 0; }
: "${DATABASE_URL:?DATABASE_URL is not set}"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c 'CREATE TABLE IF NOT EXISTS _sqlx_migrations (version BIGINT PRIMARY KEY, description TEXT NOT NULL, installed_on TIMESTAMPTZ NOT NULL DEFAULT now(), success BOOLEAN NOT NULL, checksum BYTEA NOT NULL, execution_time BIGINT NOT NULL)'
for f in $(ls -1 "$dir" | grep -E '^[0-9]+_.*\.sql$' | grep -v '\.down\.sql$' | sort -n); do
  version="${f%%_*}"
  done_already=$(psql "$DATABASE_URL" -tAq -c "SELECT 1 FROM _sqlx_migrations WHERE version = $version")
  if [ "$done_already" = "1" ]; then continue; fi
  name="${f#*_}"; name="${name%.up.sql}"; name="${name%.sql}"
  description=$(printf '%s' "$name" | tr '_' ' ' | sed "s/'/''/g")
  checksum=$(sha384sum "$dir/$f" | cut -d' ' -f1)
  echo "[devlaunch] applying migration $f"
  { echo 'BEGIN;'; cat "$dir/$f"; echo
    echo "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) VALUES ($version, '$description', true, decode('$checksum', 'hex'), 0);"
    echo 'COMMIT;'; } | psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q
done
echo "[devlaunch] migrations applied"
