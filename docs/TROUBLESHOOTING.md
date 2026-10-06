# Troubleshooting

Start with `./devlaunch doctor`: it checks the machine and says how to fix what it finds.

## The dashboard says "running older code"

DevLaunch was started before the code on disk changed. Stop it (Ctrl-C in its terminal) and
`./devlaunch start` again. The commit it runs is shown in `GET /api/health`
(`build.running` vs `build.head`).

## Deploying a new repository stopped the one I had running

That is on purpose. DevLaunch runs `DEVLAUNCH_MAX_CONCURRENT_DEPLOYMENTS` deployments at
once (default 1, because a 6 GB Docker VM cannot safely hold more). The dashboard and
`./devlaunch deploy` stop the oldest running one, and clean it up, before starting the new
one; the dashboard says which before you click. Its record shows
`replaced by <the new repository>`. To keep two running, raise the limit in `.env` if your
VM is larger.

A script calling the API without `"replace": true` is refused with `409` instead, and told
which deployment is in the way.

## OUT_OF_MEMORY during install

DevLaunch already retried with more memory, up to what your Docker VM can spare. The
message lists every limit tried. To give it more: `colima stop && colima start --cpu 4
--memory 8` (leave macOS at least 2 GB), or start every run higher with
`DEVLAUNCH_CONTAINER_MEMORY_MB=2048` in `.env`.

## PARTIALLY_READY / APPLICATION_UNHEALTHY

Everything started, but the end-to-end check failed. The panel names the check:

- **`web → api`**: the frontend was given an API address that does not answer. Is the API
  service up? Its own failure is shown beside it.
- **`api → postgres`** (or another database): the service cannot reach the database DevLaunch
  started. Usually the application reads a different variable name for its connection
  string than the ones DevLaunch set; the log shows which it tried.
- **`<service> answers`** with a 5xx: the application is erroring; its log has the traceback.

## AWAITING_INPUT

The repository needs values only you can give. Each is labelled: a key from an outside service
(Stripe, OpenAI…), another secret, or a plain setting. Leave blank what the project does not
need. Secrets an app uses only to sign its own sessions are generated for you.

## "This is a … project" / UNSUPPORTED_PROJECT

A runtime DevLaunch has no image for (Java, Go, Rust, PHP, Ruby, .NET…) is run from the
repository's own Dockerfile or compose file when it has one — the run says "Running it from
its own Dockerfile instead". Without one, or when its code is not in the repository at all
(git links to other repositories with no `.gitmodules`), the message says which.

## "Its own compose.yaml cannot be run here"

The repository's Docker setup asks for something the sandbox withholds — `privileged`, added
capabilities, host folders, host networking, the Docker socket. The message names each one.
Such a setup has to be run by hand, by someone who has read it.

## The repository's Dockerfile did not build

The build log is in the run's log, step by step. A Dockerfile using BuildKit-only syntax
(`RUN --mount`, heredocs) cannot build here: DevLaunch's builder is the one that keeps build
steps off your network.

## INVALID_MANIFEST

`package.json` is not valid JSON — usually a trailing comma or a comment. The message gives
the parser's position. No package manager can read it, so nothing was started.

## 421 "DevLaunch answers requests addressed to this machine"

Open DevLaunch at `http://127.0.0.1:3939` or `http://localhost:3939`. If you serve it under
another name on purpose (a VM, a devcontainer), add that name to `DEVLAUNCH_ALLOWED_HOSTS`.

## A page works on your Mac but fails here

Linux file names are case-sensitive. If the planning warnings mention an import that "only
matches a file if letter case is ignored", fix that import's spelling in the repository.

## The page loads but every API call fails

Look for a planning warning about a dev-server proxy or an address pointing at
`localhost`. Inside a container, `localhost` is the frontend itself. Set
`DEVLAUNCH_REWRITE_SOURCE=1` to let DevLaunch fix that literal in its own clone.

## Leftover containers or volumes

`./devlaunch clean` (with DevLaunch stopped) removes only what DevLaunch labelled as its own.
Your other images and containers are never touched.

## Logs

`./devlaunch logs <id>` while it runs; `GET /api/deployments/:id/events` for the timeline,
which is kept even after a restart.
