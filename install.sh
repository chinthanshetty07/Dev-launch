#!/usr/bin/env bash
#
# Install DevLaunch on this computer — with everything it needs.
#
#   curl -fsSL https://raw.githubusercontent.com/chinthanshetty07/Dev-launch/main/install.sh | bash
#
# What it does:
#   1. Looks at what this computer is missing: git, Node 20+, a running Docker.
#   2. Says exactly what it will install, and asks once. (DEVLAUNCH_YES=1 answers yes.)
#   3. Installs it:
#        Node   — into ~/.devlaunch/tools, for DevLaunch only; no password, nothing system-wide.
#        git    — macOS: with Homebrew; Linux: with the system's package manager.
#        Docker — macOS: Colima (free, open source) with Homebrew; an existing Docker
#                 Desktop or OrbStack is used as it is. Linux and WSL2: Docker Engine,
#                 from Docker's own install script.
#        Homebrew, on a Mac that has none and needs it.
#      Installing git, Docker or Homebrew asks for this computer's password: that is the
#      computer's rule for installing system software, not DevLaunch's.
#   4. Downloads DevLaunch into ~/devlaunch (or $DEVLAUNCH_DIR), installs it, starts it, and
#      opens the dashboard. (DEVLAUNCH_NO_START=1 skips starting it.)
#
# macOS 13+ and Linux (Debian/Ubuntu, Fedora, Arch). On Windows, run it inside WSL2.
set -euo pipefail

REPO="${DEVLAUNCH_REPO:-https://github.com/chinthanshetty07/Dev-launch.git}"
DIR="${DEVLAUNCH_DIR:-$HOME/devlaunch}"
TOOLS="$HOME/.devlaunch/tools"
NODE_MAJOR=22

say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
die() { printf '\n✗ %s\n' "$*" >&2; exit 1; }

# Root needs no sudo (a container, a fresh server); everyone else does for system software.
if [ "$(id -u)" = 0 ]; then SUDO=""; else SUDO="sudo"; fi

# The question is read from the terminal even when this script arrives through a pipe.
ask() {
  [ "${DEVLAUNCH_YES:-}" = 1 ] && return 0
  local reply
  if ! { exec 3</dev/tty; } 2>/dev/null; then
    die "No terminal to ask on. Run it again with DEVLAUNCH_YES=1 to install without asking."
  fi
  printf '%s [Y/n] ' "$1"
  read -r reply <&3 || reply=""
  exec 3<&-
  case "$reply" in ""|y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

# --- What is this computer? ---------------------------------------------------------------
case "$(uname -s)" in
  Darwin) os=mac ;;
  Linux) os=linux; grep -qi microsoft /proc/version 2>/dev/null && os=wsl ;;
  *) die "DevLaunch installs on macOS and Linux. On Windows, open your WSL2 (Ubuntu) terminal and run this there." ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) die "This processor ($(uname -m)) is not supported. DevLaunch needs x86-64 or ARM64." ;;
esac

# Node installed by an earlier run of this script comes first.
export PATH="$TOOLS/node/bin:$TOOLS/bin:$PATH"
for brew in /opt/homebrew/bin/brew /usr/local/bin/brew; do
  [ -x "$brew" ] && eval "$("$brew" shellenv)" && break
done

node_ok() { command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 20 ]; }
docker_running() { docker info >/dev/null 2>&1; }

# --- What is missing ----------------------------------------------------------------------
need_git=0; need_node=0; docker_plan=""; need_brew=0
command -v git >/dev/null 2>&1 || need_git=1
node_ok || need_node=1

if docker_running; then
  docker_plan=""
elif [ "$os" = mac ]; then
  if [ -d /Applications/Docker.app ]; then docker_plan="start-desktop"
  elif [ -d /Applications/OrbStack.app ]; then docker_plan="start-orbstack"
  elif command -v colima >/dev/null 2>&1; then docker_plan="start-colima"
  else docker_plan="install-colima"
  fi
else
  if command -v docker >/dev/null 2>&1; then
    # Installed. Either the service is stopped, or this user may not use it yet.
    if $SUDO docker info >/dev/null 2>&1; then docker_plan="grant"; else docker_plan="start-engine"; fi
  else
    if [ "$os" = wsl ] && [ "$(ps -p 1 -o comm= 2>/dev/null)" != systemd ]; then
      die "Docker needs systemd in WSL. Either turn on Docker Desktop's WSL integration for this distro (Docker Desktop → Settings → Resources → WSL integration), or enable systemd: add [boot] systemd=true to /etc/wsl.conf, run 'wsl --shutdown' in Windows, reopen this terminal and run the installer again."
    fi
    docker_plan="install-engine"
  fi
fi

if [ "$os" = mac ] && ! command -v brew >/dev/null 2>&1; then
  { [ "$need_git" = 1 ] || [ "$docker_plan" = install-colima ] || [ "$docker_plan" = start-colima ]; } && need_brew=1
fi

say "DevLaunch installer — $os, $arch"
if [ "$need_git$need_node$need_brew" = 000 ] && [ -z "$docker_plan" ]; then
  say "✓ git, Node $(node --version) and Docker are already here."
else
  say ""
  say "This computer needs:"
  [ "$need_brew" = 1 ] && say "  • Homebrew — the standard macOS package manager (asks for your password)"
  [ "$need_git" = 1 ] && say "  • git"
  [ "$need_node" = 1 ] && say "  • Node $NODE_MAJOR — into $TOOLS, for DevLaunch only"
  case "$docker_plan" in
    install-colima) say "  • Docker, as Colima (free, open source) — a small Linux VM that runs containers" ;;
    start-colima) say "  • Colima is installed but stopped — it will be started" ;;
    start-desktop) say "  • Docker Desktop is installed but not running — it will be opened" ;;
    start-orbstack) say "  • OrbStack is installed but not running — it will be opened" ;;
    install-engine) say "  • Docker Engine, from Docker's own install script (asks for your password)" ;;
    start-engine) say "  • Docker is installed but not running — it will be started (asks for your password)" ;;
    grant) say "  • Permission for you to use Docker — you are added to the 'docker' group (asks for your password)" ;;
  esac
  say ""
  ask "Install these now?" || die "Nothing was installed. Run the installer again when you are ready."
fi

# --- Install what is missing --------------------------------------------------------------
if [ "$need_brew" = 1 ]; then
  step "Installing Homebrew"
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  for brew in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    [ -x "$brew" ] && eval "$("$brew" shellenv)" && break
  done
  command -v brew >/dev/null 2>&1 || die "Homebrew did not install. See https://brew.sh, then run this again."
fi

if [ "$need_git" = 1 ]; then
  step "Installing git"
  if [ "$os" = mac ]; then brew install git
  elif command -v apt-get >/dev/null 2>&1; then $SUDO apt-get update -qq && $SUDO apt-get install -y -qq git curl ca-certificates xz-utils
  elif command -v dnf >/dev/null 2>&1; then $SUDO dnf install -y -q git curl xz
  elif command -v pacman >/dev/null 2>&1; then $SUDO pacman -Sy --noconfirm git curl xz
  else die "Could not install git: no apt, dnf or pacman here. Install git yourself, then run this again."
  fi
fi

if [ "$need_node" = 1 ]; then
  step "Installing Node $NODE_MAJOR for DevLaunch"
  nos=$([ "$os" = mac ] && echo darwin || echo linux)
  base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  sums=$(curl -fsSL "$base/SHASUMS256.txt") || die "Could not reach nodejs.org to download Node."
  file=$(printf '%s\n' "$sums" | awk -v f="-$nos-$arch.tar.gz" '$2 ~ f"$" {print $2; exit}')
  [ -n "$file" ] || die "No Node $NODE_MAJOR download for $nos-$arch."
  tmp=$(mktemp -d)
  curl -fsSL "$base/$file" -o "$tmp/$file"
  # The download is checked against nodejs.org's own list before anything runs from it.
  want=$(printf '%s\n' "$sums" | awk -v f="$file" '$2 == f {print $1}')
  got=$( (command -v sha256sum >/dev/null && sha256sum "$tmp/$file" || shasum -a 256 "$tmp/$file") | awk '{print $1}')
  [ "$want" = "$got" ] || { rm -rf "$tmp"; die "The Node download did not match its checksum; nothing was installed."; }
  rm -rf "$TOOLS/node" && mkdir -p "$TOOLS"
  tar -xzf "$tmp/$file" -C "$tmp" && mv "$tmp/${file%.tar.gz}" "$TOOLS/node"
  rm -rf "$tmp"
  node_ok || die "Node did not install correctly."
  say "    Node $(node --version) in $TOOLS/node"
fi

# Commands that need the docker group before this shell has it run through `sg`.
DOCKER_GROUP_SHELL=0
case "$docker_plan" in
  install-colima|start-colima)
    step "Setting up Docker (Colima)"
    command -v colima >/dev/null 2>&1 || brew install colima docker
    command -v docker >/dev/null 2>&1 || brew install docker
    # Half the Mac's memory, between 4 and 8 GB, and half its processors (at least 2).
    mem_gb=$(( $(sysctl -n hw.memsize) / 1073741824 / 2 )); [ "$mem_gb" -lt 4 ] && mem_gb=4; [ "$mem_gb" -gt 8 ] && mem_gb=8
    cpus=$(( $(sysctl -n hw.ncpu) / 2 )); [ "$cpus" -lt 2 ] && cpus=2
    colima start --cpu "$cpus" --memory "$mem_gb"
    ;;
  start-desktop) step "Opening Docker Desktop"; open -a Docker ;;
  start-orbstack) step "Opening OrbStack"; open -a OrbStack ;;
  install-engine)
    step "Installing Docker Engine"
    curl -fsSL https://get.docker.com | $SUDO sh
    $SUDO systemctl enable --now docker 2>/dev/null || $SUDO service docker start || true
    ;;
  start-engine)
    step "Starting Docker"
    $SUDO systemctl enable --now docker 2>/dev/null || $SUDO service docker start || true
    ;;
esac
if [ "$os" != mac ] && [ -n "$docker_plan" ] && [ -n "$SUDO" ]; then
  # Using Docker without sudo, as DevLaunch does, needs the docker group. It takes effect
  # at the next login; until then this script runs its Docker steps through `sg`.
  if ! id -nG "$USER" | grep -qw docker; then
    $SUDO usermod -aG docker "$USER"
  fi
  docker info >/dev/null 2>&1 || DOCKER_GROUP_SHELL=1
fi

in_docker_group() {
  if [ "$DOCKER_GROUP_SHELL" = 1 ]; then sg docker -c "$(printf '%q ' "$@")"; else "$@"; fi
}

if [ -n "$docker_plan" ]; then
  step "Waiting for Docker"
  for _ in $(seq 1 90); do in_docker_group docker info >/dev/null 2>&1 && break; sleep 2; done
  in_docker_group docker info >/dev/null 2>&1 || die "Docker did not start. Start it yourself (open Docker Desktop, or: colima start, or: sudo systemctl start docker), then run this again."
fi
say "✓ Docker is running ($(in_docker_group docker info --format '{{.OperatingSystem}}' 2>/dev/null))"

# pnpm, through corepack (part of Node), into DevLaunch's own folder — no password.
if ! command -v pnpm >/dev/null 2>&1; then
  mkdir -p "$TOOLS/bin"
  corepack enable --install-directory "$TOOLS/bin" >/dev/null 2>&1 || die "Could not set up pnpm. Run: npm install -g pnpm, then run this again."
fi

# --- DevLaunch itself ---------------------------------------------------------------------
if [ -d "$DIR/.git" ]; then
  step "Updating DevLaunch in $DIR"
  git -C "$DIR" pull --ff-only
elif [ -e "$DIR" ]; then
  die "$DIR exists and is not a DevLaunch download. Move it away, or choose another folder: DEVLAUNCH_DIR=/some/folder"
else
  step "Downloading DevLaunch into $DIR"
  git clone --depth 1 "$REPO" "$DIR"
fi

cd "$DIR"
step "Installing DevLaunch (packages, runner images, and the guard that keeps containers off your network)"
say "This takes a few minutes the first time."
in_docker_group ./devlaunch install

say ""
say "DevLaunch is installed. Next time, start it with:"
say "    cd \"$DIR\" && ./devlaunch start"
[ "$DOCKER_GROUP_SHELL" = 1 ] && say "(Log out and back in once, so your user can use Docker without sudo.)"

if [ "${DEVLAUNCH_NO_START:-}" = 1 ]; then exit 0; fi
step "Starting DevLaunch — the dashboard opens at http://127.0.0.1:3939 (Ctrl+C stops it)"
( for _ in $(seq 1 120); do
    if curl -sf http://127.0.0.1:3939/api/health >/dev/null 2>&1; then
      if command -v open >/dev/null 2>&1; then open http://127.0.0.1:3939
      elif command -v xdg-open >/dev/null 2>&1; then xdg-open http://127.0.0.1:3939 >/dev/null 2>&1
      elif command -v wslview >/dev/null 2>&1; then wslview http://127.0.0.1:3939
      fi
      exit 0
    fi
    sleep 2
  done ) &
in_docker_group ./devlaunch start
