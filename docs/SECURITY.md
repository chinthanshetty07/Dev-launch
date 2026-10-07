# Security

> **At a glance.** Every repository runs in a container that is non-root, has a read-only
> root file system, no Linux capabilities, `no-new-privileges`, memory/CPU/process limits,
> no Docker socket, and sits on a network that cannot reach your LAN, cloud metadata or the
> VM itself. DevLaunch's own secrets never enter a container. Plans — from rules or a model —
> pass a command allowlist and a denylist of environment variables that load code
> (`NODE_OPTIONS`, `LD_*`, the code-loading `PYTHON*` names, `PIP_*`, `YARN_*`, `COREPACK_*`,
> `TS_NODE_COMPILER`…). When DevLaunch cannot run a repository its own way, it builds and runs
> the repository's own Dockerfile or compose file under a **balanced** profile (below):
> builds happen off the local network, and privileged mode, added capabilities, host mounts,
> host namespaces and the Docker socket are refused by name. Only public `https://github.com`
> URLs are accepted, with size and time limits; links in a clone that point outside it are
> removed. The API answers only requests addressed to this machine, from its own pages.
> Secrets are hidden from the API, the dashboard, logs, saved records and the model. Records
> are readable only by you. Details and the tests that prove each control follow.

DevLaunch runs code written by strangers. This document states the threat model, what is
actually enforced, and — equally important — what is not.

Every control listed as enforced is asserted by an integration test against a **real
container**, reading what the kernel reports rather than what Docker was asked for. A
security claim nothing verifies is a comment.

## Threat model

**Assumed hostile:** the repository. Its code, its `package.json` scripts, its README,
its manifests, its filenames.

**Assumed trusted:** the person running DevLaunch, the host, the Docker daemon.

**Out of scope:** a malicious Docker daemon, kernel exploits, hostile container escapes
that defeat namespace isolation, and supply-chain attacks on the package registries
themselves.

The goal is not to make untrusted code safe to run. It is to make running it *bounded*:
no host access, no network access to your LAN, no persistence, no privilege.

## What is enforced

| Control | Setting | Verified by |
|---|---|---|
| Non-root | uid/gid 1000 | `id` inside the container |
| Capabilities | `capDrop ALL` | `CapBnd` is all zeros in `/proc/self/status` |
| Database containers | Same profile, run as the image's own uid 999 | Measured: the entrypoints only chown and switch user when started as root |
| Build scratch | `TMPDIR` on the workspace volume, not the tmpfs | `/tmp` keeps `noexec,nosuid`; the volume was always writable and executable, since `node_modules/.bin` lives there |
| Privilege escalation | `no-new-privileges` | `NoNewPrivs: 1` in `/proc/self/status` |
| Root filesystem | read-only | a write to `/` is refused |
| Writable area | volume at `/workspace` only | a write there succeeds |
| Scratch space | tmpfs at `/tmp`, `noexec,nosuid` | `/proc/mounts`, **and** a staged executable is refused |
| Memory | 1 GB, swap equal to it | cgroup `memory.max` |
| CPU | 2 cores | cgroup `cpu.max` quota/period |
| Processes | 256 | cgroup `pids.max` |
| Docker socket | never mounted | absent inside the container |
| Egress | RFC1918 + link-local + VM host blocked | gateway connection times out |
| Images | allowlist, frozen at module load | unapproved image refused |
| Commands | allowlisted binaries, no metacharacters | 27 injection vectors refused |
| Paths | traversal rejected | including post-normalisation escapes |
| Repository intake | public `github.com` HTTPS only | ssh/other hosts/credentials refused |

Rejections happen **before Docker is touched at all** — an unapproved image or a
malicious command never reaches container creation.

## What is deliberately not enforced

### Network egress is open to the internet

Containers reach the public internet, because `npm install` and `pip install` need
package registries. Restricting that meaningfully requires a MITM proxy with a package
allowlist, which is out of scope.

What *is* blocked: RFC1918, link-local (`169.254.0.0/16`, where cloud metadata endpoints
live), and the Colima VM itself.

### Repository scripts are not inspected

`npm run dev` runs whatever `scripts.dev` contains. The allowlist constrains the script
**name**, never the body — real dev scripts chain commands (`tsc && vite build`), so
rejecting metacharacters there would reject most legitimate repositories while stopping
nothing the container does not already contain.

Instead the resolved command is **displayed in the UI before execution**. That converts
a hidden assumption into informed consent.

> The allowlist constrains what DevLaunch composes.
> The container constrains what the repository does.

### A repository's own Docker setup: the fallback, under a balanced profile

Used only when DevLaunch cannot run a repository its own way (a stack it has no image for,
a layout no rule reads) and the repository ships a Dockerfile or compose file. The user
chose the trade-off: the image keeps its own user (often root inside the container) and a
writable root filesystem, because real images need both; everything else holds.

- **What the Docker daemon fetches itself is judged first.** `ADD <url>`, and pulling the
  images `FROM`, `COPY --from` and a compose `image:` name, are made by the daemon on the VM's
  own network — outside the egress rules (found by the independent verifier). So: `ADD` from
  any URL is refused (download it in a `RUN` step, which *is* under the rules); a registry
  that is an address, `localhost`, a local-only name, or a name resolving to a private,
  loopback, link-local or CGNAT address is refused; a compose image is pulled fresh from its
  registry every time, so a private image on this machine — or DevLaunch's own, or another
  run's — is never used. `DockerfileChecks.ts`, `dockerfileChecks.test.ts`,
  `repoDockerRunner.test.ts`.
- **Builds** run through Docker's classic builder with `networkmode: devlaunch-net`, so
  every `RUN` step meets the egress rules. Measured: on Docker's default network a build
  step reached the home router, the metadata address and the VM; on `devlaunch-net` all
  three timed out, while package registries stayed reachable. A BuildKit builder was
  rejected: `buildx` creates it privileged, and a rootless one cannot start in this VM
  without relaxing its AppArmor user-namespace restriction. Builds are memory- and
  CPU-limited and labelled; images are tagged `devlaunch-built/…` and removed with the run.
  Only images under that name are ever removed; after a crash, the next start removes those
  a dead process left. A stop or a replace stops a build in progress, and a build's memory is
  counted against the VM while it runs.
- **Process limit for builds** (verifier D-2, closed): the classic builder takes no process
  limit of its own, so every build runs under a VM cgroup, `devlaunch-build`, capped at
  2,048 processes and 4 GB (`--cgroup-parent`). `./devlaunch install` creates it and a boot
  service in the VM recreates it after a restart. Docker would create a missing cgroup with
  *no* limit, so DevLaunch reads the cap before every build and refuses to build without
  it. Measured: a `RUN` starting 3,000 processes started all of them without the cap, and
  stopped at 2,048 with "can't fork" under it (`integration/repoDocker.test.ts`).
- **Not closed, stated:** a build step runs with Docker's default capabilities (including
  `NET_RAW`) — the classic builder takes no capability settings. Raw sockets during a build
  could spoof traffic on `devlaunch-net`, where only builds and DevLaunch's own checks are:
  runs have networks of their own. It does not reach the Mac or the local network.
- **Containers** (`buildRepoImageHostConfig`): not privileged, no capabilities added,
  `NET_RAW`, `MKNOD`, `AUDIT_WRITE`, `SETFCAP`, `SYS_CHROOT`, `SETPCAP`, `FSETID` dropped,
  `no-new-privileges`, memory/CPU/pids limits, no binds, no devices, no host PID/IPC/network,
  on the run's own network (below).
- **A network of its own for every run** (verifier D-8, closed): each run, whichever way
  it runs, gets a bridge network from `172.31.0.0/16`, the range the egress rules cover.
  Containers on different bridges cannot reach each other, so two runs at once cannot
  reach each other's services or databases by name or by address. Before the first one,
  DevLaunch checks on this VM that a network from that range is under the rules (a
  container on it must not reach the VM); until it is, runs share `devlaunch-net` and the
  log says so. A run's network is removed when the run ends; after a crash, the next start
  removes it. Measured with two runs at once: each reached its own service and not the
  other's (`integration/concurrency.test.ts`).
- **Compose** is translated, never handed to `docker compose`. Refused, with the key named:
  `privileged`, `cap_add`, `devices`, `security_opt`, `sysctls`, `userns_mode`, host
  `network_mode`/`pid`/`ipc`, the Docker socket, bind mounts and `env_file`s outside the
  repository, remote build contexts, build `ssh`/`secrets`/`network`. Bind mounts inside
  the repository are dropped with a warning (the image carries its code).
- **Only DevLaunch's reader** may produce a plan that runs an image: the validator refuses
  one from a model.

Proven by `integration/repoDocker.test.ts` (a breakout image probing metadata, the Docker
bridge, the VM and private ranges from a build step and from the running container — all
BLOCKED), `repoDockerSafety.test.ts` and `repoDockerSetup.test.ts`.

### This machine only

DevLaunch has no login, so it listens on loopback — which keeps the network out but not a
browser. Every HTTP request and log-socket upgrade must be addressed to `localhost`,
`127.0.0.1` or `[::1]` (or a name in `DEVLAUNCH_ALLOWED_HOSTS`) and, when it carries an
`Origin`, come from such a page. A DNS-rebinding page is answered `421`, a cross-site page
`403` (`hostGuard.test.ts`).

### Secrets stay out of what leaves

Values a person types, secrets DevLaunch generates and database passwords are hidden in
`GET /api/sessions/:id` and the Plan panel (`publicPlan`), masked in log lines
(`maskUrlPassword`), never written to records (`deploymentRecords.test.ts`), and never sent
to the model: a repair prompt names variables without their values, and a value the model
hands back hidden keeps the real one (`ai.test.ts`). Each run's database gets its own
password and, when another run holds the plain name, its own network name.

### Links in a clone

git checks symbolic links out as links, and DevLaunch reads the clone on this machine. Every
link that resolves outside the clone — absolute, `../`, through another link, or dangling —
is removed right after the clone, and said so in the log (`escapingLinks.test.ts`).

## Two findings worth recording

### `DOCKER-USER` only sees forwarded traffic

The egress policy originally used a single chain jumped to from `DOCKER-USER`. That
chain filters *forwarded* packets only. A packet from a container to the VM itself —
**its own default gateway included** — terminates locally and hits `INPUT`, which
`DOCKER-USER` never sees.

With only the forward chain, a container could still reach every service listening on
the Colima VM. This was caught by a test asserting the gateway times out: the probe
reported `refused`, proving the gateway had answered. Both chains are now installed.

Both begin with a conntrack `ESTABLISHED,RELATED` return, without which replies to
published ports are dropped — the reply travels back toward the Docker gateway, which is
itself inside a blocked range.

### `CapEff` does not prove capabilities were dropped

The capability check originally asserted `CapEff` (the effective set) was empty. It was
— but it is empty for **any** non-root process, with or without `--cap-drop`. Measured
inside this runner image: `CapEff` is `0000000000000000` in both cases, so the assertion
proved only that the container is non-root, which another test already covered.

`CapBnd`, the bounding set, is the value `--cap-drop ALL` actually zeroes
(`00000000a80425fb` without it). It is the ceiling on what a process could ever acquire,
including through a setuid binary, so it is the meaningful assertion. Found by deleting
`CapDrop` from the container config and observing that the capability test stayed green.

### Environment variables could override validated commands

The wrapper reads its commands from `$DL_START_CMD`. Plan-supplied variables were
applied **after** those were set, so a plan declaring a variable named `DL_START_CMD`
replaced an allowlisted command with arbitrary text, bypassing validation entirely.

Defended twice now: the reserved `DL_` prefix is rejected outright, and the wrapper
assigns control variables **last**, so a future caller that skips validation is still
safe. The exploit was written as a failing test before the fix.

## A workspace kept for one session, and no longer

`/workspace` is a named volume per session, not an anonymous one per container, so a
restart can keep what an earlier container installed. The limits on that:

- **One session.** The volume's name and labels carry the session; nothing from one
  session is ever mounted in another, and teardown removes every volume the session
  made. The startup sweep removes any a dead process left, as it does containers.
- **Reused only after a finished install of the same thing:** the same image, install
  command and install directory, and the install must have printed its success marker.
  A failed install, or one cut off by a stop or a kill, leaves nothing to trust, and
  the next attempt gets a fresh volume.
- **Decided by DevLaunch, never a plan.** The wrapper skips the install only on
  `DL_INSTALL_REUSED=1`, a control variable set last and unconditionally; the `DL_` prefix
  is refused from every plan.
- Services that install one shared workspace share its volume, as they already shared
  the tree: the same repository, the same session.

## A file DevLaunch writes, and what may be in it

For an unbuildable pyproject project DevLaunch writes one file into the container,
`/workspace/.devlaunch/requirements.txt`, beside the wrapper and copied after the
repository so the repository cannot shadow it. It is never written to a checkout or a
clone. Three properties keep it from being a way around the allowlist:

- **Its content comes from the repository at launch, not from a plan.** A plan — a
  model's included — can name the path, in any of its steps; it cannot choose what the
  file says. Which step names it changes only *when* it is used, never what is in it.
- **Every line is rebuilt, then checked** against `SAFE_REQUIREMENT`: a name, optional
  extras, version clauses. A requirements file obeys options (`--index-url`, `-e`, `-r`),
  and none can be expressed. Anything else becomes the bare name, which is what was
  installed before this existed.
- **The read stays inside the source directory,** checked again at the read even though
  the working directory was validated long before — a tested second layer, like the
  ordering of the `DL_` variables.

What it installs is what the repository declared, as before; only the version ranges are
new. A repository could always name any package it liked.

## Operational notes

- The egress policy lives inside the Colima VM. A boot service the setup script installs
  (`devlaunch-network-rules.service`, run after Docker starts) restores it at every VM
  start, so `colima stop`/`start` and a Mac reboot keep it; only **recreating** the VM
  loses it — re-run `scripts/setup-network-policy.sh` after `colima delete`. The backend
  still checks the rules by behaviour and warns when they are missing (`EgressProbe`). If the policy network
  is absent the runner falls back to the default bridge and the security suite **fails
  loudly** rather than passing with weaker isolation.
- Environment values supplied through the UI are held in memory only, never written to
  disk, and injected at container create.
- Only public repositories are accepted, so DevLaunch never handles a credential.
- Containers are labelled, and orphans are swept **at startup** — the only thing that
  holds when the backend is `SIGKILL`ed, since graceful shutdown never runs.
