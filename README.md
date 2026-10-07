# DevLaunch

Paste a GitHub repository URL; get the application running on your own machine — frontend,
API and database together — inside locked-down containers, checked end to end before it is
called ready.

```
GitHub URL → clone → understand → plan → install → start databases → start every service
           → check it really works → working URL      (and a clear reason when it cannot)
```

DevLaunch works out how to run a project from the project itself: its manifests, lockfiles,
compose file, README and source. Known shapes are planned by rules; a model is consulted only
when no rule matches, and its plan is checked like any other. What it supports, measured on 40
real repositories, is in [docs/SUPPORTED_STACKS.md](docs/SUPPORTED_STACKS.md).

## Install

On a Mac or Linux computer (on Windows: inside WSL2), open a terminal and run:

```bash
curl -fsSL https://raw.githubusercontent.com/chinthanshetty07/Dev-launch/main/install.sh | bash
```

That is all. The installer:

1. checks what the computer is missing — git, Node 20+, a running Docker;
2. lists what it will install and asks you once;
3. installs it:

   | | Mac | Linux / WSL2 |
   |---|---|---|
   | Node | into `~/.devlaunch/tools`, for DevLaunch only | same |
   | git | with Homebrew (installed too if missing) | with apt, dnf or pacman |
   | Docker | Colima (free, open source), with Homebrew. Docker Desktop or OrbStack, if you have one, is used as it is | Docker Engine, from Docker's own script; you are added to the `docker` group |

   Installing git, Docker or Homebrew asks for your computer's password — your computer's
   rule for system software;
4. downloads DevLaunch into `~/devlaunch`, sets it up, starts it and opens the dashboard.

Next time, start it with:

```bash
cd ~/devlaunch && ./devlaunch start          # http://127.0.0.1:3939
```

Open <http://127.0.0.1:3939> and paste a repository URL. One runs at a time: pasting the next
one stops the last and cleans it up. No account or login: DevLaunch only answers on your own
computer, and refuses requests from websites. Or from another terminal:

```bash
./devlaunch deploy https://github.com/mdn/todo-react
```

Prefer to do it by hand? `git clone https://github.com/chinthanshetty07/Dev-launch.git`, then
`./devlaunch install` and `./devlaunch doctor` inside it.

**AI help is optional.** Rules plan most repositories. For the ones no rule recognises, add a
free key from [console.groq.com](https://console.groq.com) as `GROQ_API_KEY=...` in a `.env`
file in the DevLaunch folder, and restart it.

## From the website

The [DevLaunch website](site/index.html) has a paste box with a **Run on my computer** button.
It opens your own DevLaunch with the repository filled in; nothing runs until you press
**Run it** there. The website has no server and never sees what you run.

## Commands

| Command | What it does |
|---|---|
| `./devlaunch install` | Install dependencies, build the runner images, set up the protected network and the guard |
| `./devlaunch doctor` | Check Node, pnpm, git, Docker, images, network, port, disk, `.env` — and say how to fix each problem |
| `./devlaunch start` | Build the dashboard and start DevLaunch on port 3939 |
| `./devlaunch deploy <url> [ref]` | Deploy a repository (optionally a branch, tag or commit) and follow it to the end |
| `./devlaunch status [id]` | List deployments, or show one |
| `./devlaunch logs <id>` | A running deployment's output |
| `./devlaunch stop <id>` | Stop a deployment and remove what it started |
| `./devlaunch test [--all]` | Typecheck and tests (`--all` adds the real-Docker tests, ~10 min) |
| `./devlaunch clean [--caches]` | Remove leftover DevLaunch containers and workspaces (DevLaunch stopped) |
| `./devlaunch uninstall` | Remove everything DevLaunch added to Docker — rules, build cap, networks, images, volumes — and nothing else |

## What "ready" means

A deployment is **READY** only after:

1. every service answers on its port,
2. every API address a frontend was given answers,
3. every service can reach the databases DevLaunch started for it, from inside its own container.

If something started but a check failed, it is **PARTIALLY_READY**, with the failed check
named. If the repository needs a value only you can give (a Stripe key, say), it stops and
asks — labelled — before starting anything. If it cannot be run at all, it says why, with the
exact log line, and what to do next.

## Configuration

Optional, in a `.env` file at the repository root (never committed):

| Setting | Default | What it does |
|---|---|---|
| `GROQ_API_KEY` | — | Lets a model plan repositories no rule recognises |
| `DEVLAUNCH_CONTAINER_MEMORY_MB` | 1024 | Memory each run starts with (retries go higher, up to what the VM can spare) |
| `DEVLAUNCH_MAX_CONCURRENT_DEPLOYMENTS` | 1 | Deployments at once — raise only with a larger Docker VM |
| `DEVLAUNCH_MAX_REPAIR_ATTEMPTS` | 2 | Plan repairs per service |
| `DEVLAUNCH_TIMEOUT_TIME_TO_READY_MS` | 600000 | How long a service may take to come up |
| `DEVLAUNCH_REWRITE_SOURCE` | off | Let DevLaunch fix two kinds of `localhost` literal, in its own clone only |
| `DEVLAUNCH_STATE_DIR` | `~/.devlaunch` | Where deployment records and memory hints are kept |

The full list is in [docs/setup.md](docs/setup.md).

## API

`POST /api/deployments` `{ "repoUrl": "https://github.com/owner/repo" }`, then
`GET /api/deployments/:id` (identity, state, URLs, failure, repairs, check results),
`/:id/events` (timeline), `/:id/logs`, `/:id/services`, `/:id/health`,
`POST /:id/cancel`, `POST /:id/retry`, `DELETE /:id`. Add `"replace": true` to the first call
to stop whatever is running instead of getting `409`. Errors always look like
`{ "error": { "code", "category", "message", "retryable", "suggestedAction" } }`.

## Safety

Repositories are untrusted code. Each runs in a container that is non-root, read-only,
without capabilities, limited in memory, CPU and processes, without the Docker socket, and
on a network of its own that cannot reach your home network, your computer or cloud metadata.
A small DevLaunch container, `devlaunch-guard`, keeps those network rules and a process cap
for builds in place on whatever Docker you use, and puts them back after Docker restarts. A
repository's own
Dockerfile and compose file are used only when DevLaunch cannot run the repository its own
way, built off your network and run with no extra privileges, no access to your files and
no Docker socket. See [docs/SECURITY.md](docs/SECURITY.md).

## Documentation

| | |
|---|---|
| [RELEASE_REPORT.md](docs/RELEASE_REPORT.md) | The latest release check: verdict, every test count and real-repository result |
| [DEVLAUNCH_AUDIT.md](docs/DEVLAUNCH_AUDIT.md) | The production audit: every finding, its severity and status |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, data flow, the decisions behind them |
| [DEPLOYMENT_FLOW.md](docs/DEPLOYMENT_FLOW.md) | Every step from URL to working application |
| [SUPPORTED_STACKS.md](docs/SUPPORTED_STACKS.md) | What runs, and what does not yet |
| [REPAIR_ENGINE.md](docs/REPAIR_ENGINE.md) | What is fixed automatically, and the limits |
| [SECURITY.md](docs/SECURITY.md) | Threat model and every control |
| [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Common problems and their fixes |
| [TESTING.md](docs/TESTING.md) | Test suites, fixtures, real-repository runs |
| [HOSTING_PLAN.md](docs/HOSTING_PLAN.md) | What it would take to host it for other people |
| [limitations.md](docs/limitations.md) | Deliberate boundaries, stated plainly |
| [setup.md](docs/setup.md) | Every setting |
| [CHANGELOG.md](CHANGELOG.md) | What changed, and the evidence for it |

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). To report a
security problem privately, see [.github/SECURITY.md](.github/SECURITY.md).

## License

[MIT](LICENSE).
