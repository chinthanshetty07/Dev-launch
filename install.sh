#!/usr/bin/env bash
#
# Install DevLaunch on this computer.
#
#   curl -fsSL https://raw.githubusercontent.com/chinthanshetty07/Dev-launch/main/install.sh | bash
#
# What it does: checks for git, Node 20+ and a running Docker; gets pnpm through corepack
# (part of Node); downloads DevLaunch into ~/devlaunch (or $DEVLAUNCH_DIR); runs
# `./devlaunch install`, which installs its packages, builds its images and starts its
# guard container in Docker. It never installs Docker or changes system settings itself —
# when something is missing it says what, and how to get it, and stops.
#
# macOS and Linux. On Windows, run it inside WSL2 with Docker Desktop's WSL integration on.
set -euo pipefail

REPO="${DEVLAUNCH_REPO:-https://github.com/chinthanshetty07/Dev-launch.git}"
DIR="${DEVLAUNCH_DIR:-$HOME/devlaunch}"

say() { printf '%s\n' "$*"; }
missing=0
need() { say "✗ $1"; say "    → $2"; missing=1; }

say "Checking this computer..."
case "$(uname -s)" in
  Darwin) os=mac ;;
  Linux) os=linux; grep -qi microsoft /proc/version 2>/dev/null && os=wsl ;;
  *) say "✗ This installer runs on macOS and Linux (on Windows: inside WSL2)."; exit 1 ;;
esac

if command -v git >/dev/null 2>&1; then say "✓ git"; else
  case $os in
    mac) need "git is not installed" "Run: xcode-select --install" ;;
    *) need "git is not installed" "Run: sudo apt install git   (or your system's package manager)" ;;
  esac
fi

if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]; then
  say "✓ Node $(node --version)"
else
  need "Node 20 or newer is not installed" "Get it from https://nodejs.org (the LTS version), or with nvm: nvm install --lts"
fi

if ! command -v docker >/dev/null 2>&1; then
  case $os in
    mac) need "Docker is not installed" "Install Docker Desktop (https://www.docker.com/products/docker-desktop), OrbStack (https://orbstack.dev) or Colima (brew install colima docker && colima start --cpu 4 --memory 6)" ;;
    wsl) need "Docker is not available in WSL" "Install Docker Desktop for Windows and turn on Settings → Resources → WSL integration for this distro" ;;
    *) need "Docker is not installed" "Install Docker Engine: https://docs.docker.com/engine/install/ — then add yourself to the docker group: sudo usermod -aG docker \$USER (and log in again)" ;;
  esac
elif ! docker info >/dev/null 2>&1; then
  case $os in
    mac) need "Docker is installed but not running" "Open Docker Desktop or OrbStack, or run: colima start --cpu 4 --memory 6" ;;
    wsl) need "Docker is not reachable from WSL" "Start Docker Desktop, and check Settings → Resources → WSL integration for this distro" ;;
    *) need "Docker is installed but not reachable" "Run: sudo systemctl start docker — and if it says permission denied: sudo usermod -aG docker \$USER, then log in again" ;;
  esac
else
  say "✓ Docker is running ($(docker info --format '{{.OperatingSystem}}' 2>/dev/null))"
fi

if [ "$missing" = 1 ]; then
  say ""
  say "Fix the items above, then run this installer again."
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  say "Getting pnpm through corepack (comes with Node)..."
  corepack enable >/dev/null 2>&1 || true
  if ! command -v pnpm >/dev/null 2>&1; then
    say "✗ pnpm could not be set up automatically."
    say "    → Run: npm install -g pnpm   (or: sudo corepack enable), then run this installer again."
    exit 1
  fi
fi
say "✓ pnpm $(pnpm --version)"

if [ -d "$DIR/.git" ]; then
  say "Updating DevLaunch in $DIR..."
  git -C "$DIR" pull --ff-only
elif [ -e "$DIR" ]; then
  say "✗ $DIR exists and is not a DevLaunch download."
  say "    → Move it away, or choose another folder: DEVLAUNCH_DIR=/some/folder bash install.sh"
  exit 1
else
  say "Downloading DevLaunch into $DIR..."
  git clone --depth 1 "$REPO" "$DIR"
fi

cd "$DIR"
say "Installing (packages, runner images, and the guard that keeps containers off your network)."
say "This takes a few minutes the first time."
./devlaunch install

say ""
say "DevLaunch is installed. To use it:"
say "    cd \"$DIR\" && ./devlaunch start"
say "then open http://127.0.0.1:3939 and paste a GitHub repository."
