# Contributing to DevLaunch

Thanks for helping. Bug reports, repositories that do not run, and pull requests are all
welcome.

## Reporting a repository that does not run

Open an issue with:

- the repository URL (and branch, if not the default),
- what DevLaunch said — the failure title and the suggested action,
- your Docker setup (`./devlaunch doctor` prints it on its first lines).

A repository that cannot run as it is (it needs a secret only its owner has, or its lockfile
is broken) is not a DevLaunch bug, but a wrong or unclear explanation of *why* is.

## Working on the code

```bash
git clone https://github.com/chinthanshetty07/Dev-launch.git
cd Dev-launch
./devlaunch install
./devlaunch test          # typecheck + quick tests, about a minute
./devlaunch test --all    # + the real-Docker tests, 15–20 minutes
```

Layout: `apps/backend` (the engine and API), `apps/frontend` (the dashboard),
`packages/shared` (types shared by both), `docker/` (runner images and the guard),
`fixtures/` (small repositories the tests run), `site/` (the website), `docs/` (how it works).
Start with [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## What a pull request needs

- **A test for every change in behaviour**, and a check that the test fails without the
  change (break it, see it go red, restore it). See [docs/TESTING.md](docs/TESTING.md).
- **Never weaken the sandbox** to make a repository run: no Docker socket in containers, no
  privileged containers for repository code, no host folders. Repository code is untrusted.
- If a test has to change because a fact changed, say which fact in a comment beside it.
- Plain words in messages a person sees: what happened, and what to do next.
- CI must pass (it runs the quick tests and the real-Docker suite on Linux).

## Conduct

Be kind and assume good faith. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
