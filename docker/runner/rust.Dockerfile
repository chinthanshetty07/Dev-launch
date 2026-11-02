# DevLaunch Rust runner.
#
# The same sandbox as the Node and Python runners — /workspace and /cache owned by the
# non-root user, scratch space on the volume rather than in the 64 MB /tmp — with what a
# Rust web project needs to build:
#
# 1. The toolchain the image ships (rustc, cargo), plus pkg-config and the OpenSSL
#    headers: `openssl-sys`, pulled in by reqwest, sqlx and native-tls, fails its build
#    script without them, and it is in a great many web projects.
#
# 2. Node and npm: npm builds the JavaScript a Rust server serves (`npm run build` into its
#    static folder, `SL-Lee/actix-web-todo-app`); node runs two small things DevLaunch runs
#    beside every app: the loopback bridge
#    (`wrapper.ts`, `LOOPBACK_BRIDGE`) — actix and axum examples bind 127.0.0.1:8080, which
#    Docker cannot forward to — and the end-to-end check's connection test.
#
# 3. CARGO_HOME on /cache, so the crates a project downloads survive the container: a
#    repair or a second run reuses them instead of fetching the whole registry again.
ARG RUST_VERSION=1
FROM rust:${RUST_VERSION}-slim-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      pkg-config \
      libssl-dev \
      libpq-dev \
      libsqlite3-dev \
      postgresql-client \
      ca-certificates \
      nodejs \
      npm \
 && rm -rf /var/lib/apt/lists/*

# Applies a diesel project's migrations (`diesel-migrate.sh`): diesel links libpq, and its
# own CLI would take minutes to compile on every run.
COPY diesel-migrate.sh /usr/local/bin/devlaunch-diesel-migrate
# And a sqlx project's, before it compiles: its query macros check against the database
# (`sqlx-migrate.sh`).
COPY sqlx-migrate.sh /usr/local/bin/devlaunch-sqlx-migrate
RUN chmod 0755 /usr/local/bin/devlaunch-diesel-migrate /usr/local/bin/devlaunch-sqlx-migrate

# 1000:1000 matches the other runners, so ContainerSecurity needs no per-image special case.
RUN groupadd --gid 1000 app \
 && useradd --uid 1000 --gid 1000 --create-home app \
 && mkdir -p /workspace/.tmp /devlaunch /cache/cargo /cache/npm \
 && chown -R app:app /workspace /devlaunch /cache

# The toolchain stays where the image put it (RUSTUP_HOME, read-only is fine); only the
# downloaded crates and the git index move to the cache volume. The binaries the toolchain
# installed are copied there once so cargo still finds itself through CARGO_HOME/bin.
RUN cp -a /usr/local/cargo/bin /cache/cargo/bin && chown -R app:app /cache/cargo
ENV CARGO_HOME=/cache/cargo \
    PATH=/cache/cargo/bin:/usr/local/cargo/bin:$PATH \
    HOME=/workspace \
    TMPDIR=/workspace/.tmp \
    CARGO_TERM_COLOR=never \
    npm_config_cache=/cache/npm \
    npm_config_update_notifier=false \
    npm_config_fund=false \
    CARGO_INCREMENTAL=0

USER app
WORKDIR /workspace
