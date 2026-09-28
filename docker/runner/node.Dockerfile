# DevLaunch Node runner.
#
# One file, built once per approved version. Parameterised rather than copied because
# everything below is a property of DevLaunch's sandbox rather than of a Node release,
# and two copies of it would drift — the reasoning in these comments is the part that
# must not be duplicated.
#
# Built once and allowlisted; never built per run. Three things the stock node:N-slim
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
#
# 3. python-is-python3. node-gyp finds python3 by itself, but the build scripts *inside*
#    older native modules do not: sqlite3@5.0.2 unpacks its amalgamation with a bare
#    `python` from a Makefile, and without the alias the compile dies with
#    `/bin/sh: 1: python: not found` — exit 127, after a successful toolchain check —
#    which reads as a missing system library and is nothing of the kind.
ARG NODE_VERSION=20
FROM node:${NODE_VERSION}-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential \
      python3 \
      python-is-python3 \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# pnpm, because a pnpm workspace can only be installed by pnpm: its packages reference
# each other as `workspace:*`, a protocol npm refuses outright. Pinned and installed at
# build time so a repository that says nothing about its tooling still gets a fixed,
# known version rather than whatever a network fetch returns today.
RUN npm install -g pnpm@9.12.3 \
 && npm cache clean --force

# Corepack, for the repositories that *do* say.
#
# `"packageManager": "yarn@4.6.0"` in package.json is not advice. Yarn 1 — the version
# every node image ships — reads that field, refuses to proceed, and prints a paragraph
# about enabling corepack. A real repository died there twice over, both services, before
# installing a single dependency.
#
# This was deliberately avoided once, on the grounds that a run should need no network to
# obtain its own tooling. That reasoning does not survive contact with the case it
# excludes: the run already needs the network to install the dependencies themselves, and
# corepack activates *only* when a repository pins a version — which is exactly the
# situation where the pinned pnpm above is the wrong tool. The choice was never between
# network and no network; it was between the version the author chose and a failure.
#
# COREPACK_HOME on the cache volume, so the download survives the container: /workspace is
# discarded with the clone, and a repair re-fetching a 5 MB package manager is the same
# waste that moved the npm and pip caches here. The prompt is disabled because there is
# no terminal to answer it — left on, corepack blocks rather than downloads.
RUN corepack enable \
 && mkdir -p /cache/corepack \
 && chown -R node:node /cache
ENV COREPACK_HOME=/cache/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# /workspace   writable volume mount point; the repository is copied here at start
# /devlaunch   read-only staging area for the wrapper and the pristine repo copy
RUN mkdir -p /workspace/.tmp /devlaunch/src \
 && chown -R node:node /workspace /devlaunch

# /cache  package downloads, on a volume that outlives the container.
#
# Created here, owned by the runtime user, because a fresh named volume inherits the
# ownership of the image directory it is mounted over — and a root-owned mount point
# leaves a non-root process unable to write a single byte to its own cache. Without it
# the cache directory lived under /workspace, which is discarded with the clone: a repair
# re-downloading every dependency from scratch is why one failing install becomes three,
# and why the live log looks like it has stalled.
RUN mkdir -p /cache/npm /cache/pnpm /cache/corepack \
 && chown -R node:node /cache

ENV HOME=/workspace \
    npm_config_cache=/cache/npm \
    npm_config_store_dir=/cache/pnpm \
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
