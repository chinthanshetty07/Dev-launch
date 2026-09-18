# DevLaunch Node runner.
#
# Built once and allowlisted; never built per run. Two things the stock node:20-slim
# image cannot give us:
#
# 1. /workspace and /devlaunch must already exist and be owned by the non-root user.
#    An anonymous volume inherits ownership from the image path it shadows — if that
#    path does not exist, the volume mounts root-owned and a non-root process cannot
#    write to it.
#
# 2. build-essential + python3, so node-gyp can compile from source. On arm64 a great
#    many packages ship no prebuilt binary, and without a toolchain those become hard
#    failures rather than slow successes.
FROM node:20-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential \
      python3 \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# pnpm, because a pnpm workspace can only be installed by pnpm: its packages reference
# each other as `workspace:*`, a protocol npm refuses outright. Pinned and installed at
# build time rather than fetched by corepack at run time, so a run needs no network to
# obtain its own tooling and every container gets the same version.
RUN npm install -g pnpm@9.12.3 \
 && npm cache clean --force

# /workspace   writable volume mount point; the repository is copied here at start
# /devlaunch   read-only staging area for the wrapper and the pristine repo copy
RUN mkdir -p /workspace /devlaunch/src \
 && chown -R node:node /workspace /devlaunch

ENV HOME=/workspace \
    npm_config_cache=/workspace/.npm \
    npm_config_update_notifier=false \
    npm_config_fund=false

USER node
WORKDIR /workspace
