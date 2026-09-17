# Security

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

### Repository Dockerfiles are ignored

Building a repository's own Dockerfile executes arbitrary `RUN` instructions at build
time — precisely the untrusted-code execution the sandbox exists to contain.

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

## Operational notes

- The egress policy lives inside the Colima VM and **does not survive recreating it**.
  Re-run `scripts/setup-network-policy.sh` after `colima delete`. If the policy network
  is absent the runner falls back to the default bridge and the security suite **fails
  loudly** rather than passing with weaker isolation.
- Environment values supplied through the UI are held in memory only, never written to
  disk, and injected at container create.
- Only public repositories are accepted, so DevLaunch never handles a credential.
- Containers are labelled, and orphans are swept **at startup** — the only thing that
  holds when the backend is `SIGKILL`ed, since graceful shutdown never runs.
