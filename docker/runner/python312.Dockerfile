# DevLaunch Python runner.
#
# Same two requirements as the Node runner: /workspace must exist and be owned by the
# non-root user (an anonymous volume inherits ownership from the image path it shadows,
# and a volume over a missing path mounts root-owned), plus a compiler toolchain so
# packages without an arm64 wheel can build from source instead of failing outright.
FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential \
      python3-dev \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# 1000:1000 matches the Node runner, so ContainerSecurity needs no per-image special case.
RUN groupadd --gid 1000 app \
 && useradd --uid 1000 --gid 1000 --create-home app \
 && mkdir -p /workspace/.tmp /devlaunch \
 && chown -R app:app /workspace /devlaunch

# /cache  package downloads, on a volume that outlives the container.
#
# Created here, owned by the runtime user, because a fresh named volume inherits the
# ownership of the image directory it is mounted over — and a root-owned mount point
# leaves a non-root process unable to write a single byte to its own cache. Without it
# the cache directory lived under /workspace, which is discarded with the clone: a repair
# re-downloading every dependency from scratch is why one failing install becomes three,
# and why the live log looks like it has stalled.
RUN mkdir -p /cache/pip \
 && chown -R app:app /cache

# pip installs console scripts (flask, uvicorn, streamlit, gunicorn) into the user
# site directory when running non-root. Without it on PATH every Python start command
# fails with exit 127, which reads as "command not found" rather than anything useful.
ENV PATH=/workspace/.local/bin:$PATH \
    HOME=/workspace \
    PIP_CACHE_DIR=/cache/pip \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_ROOT_USER_ACTION=ignore \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

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


USER app
WORKDIR /workspace
