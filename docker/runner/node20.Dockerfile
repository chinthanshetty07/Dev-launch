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
RUN mkdir -p /workspace/.tmp /devlaunch/src \
 && chown -R node:node /workspace /devlaunch

ENV HOME=/workspace \
    npm_config_cache=/workspace/.npm \
    npm_config_update_notifier=false \
    npm_config_fund=false

# Build scratch on the volume, not in RAM.
#
# /tmp is a 64 MB tmpfs, deliberately: it is memory, and noexec/nosuid so it cannot be
# used to stage an executable payload. pip unpacks and builds there by default, so a
# single ordinary wheel — pandas, numpy — exhausts it and fails with
# `[Errno 28] No space left on device` while /workspace has tens of gigabytes free. The
# message names a disk that is nearly empty, which is why this is worth stating.
#
# /workspace is disk-backed and already writable and executable by this user, so nothing
# is weakened by building there; /tmp keeps its noexec mount for everything else.
ENV TMPDIR=/workspace/.tmp
# Created here as well as by the wrapper: pnpm resolves TMPDIR the moment it starts
# and exits with ENOENT if the directory is not already there, so `pnpm -v` alone
# fails. An anonymous volume is initialised from this path, so the directory
# survives into the mount.


USER node
WORKDIR /workspace
