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
 && mkdir -p /workspace /devlaunch \
 && chown -R app:app /workspace /devlaunch

# pip installs console scripts (flask, uvicorn, streamlit, gunicorn) into the user
# site directory when running non-root. Without it on PATH every Python start command
# fails with exit 127, which reads as "command not found" rather than anything useful.
ENV PATH=/workspace/.local/bin:$PATH \
    HOME=/workspace \
    PIP_CACHE_DIR=/workspace/.pip \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_ROOT_USER_ACTION=ignore \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

USER app
WORKDIR /workspace
