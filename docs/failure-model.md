# Failure model

An execution that fails is not an error to be logged — it is a result to be explained.
This document describes how DevLaunch decides *what went wrong*.

## Three sources of truth

Classification draws on three independent signals, because no one of them is sufficient:

| Signal | Answers | Limitation |
|---|---|---|
| Wrapper exit code | which phase owned the process | the wrapper `exec`s the start command, after which the code belongs to the app |
| Phase sentinels | how far execution got | says nothing about cause |
| Log text | why it failed | absent or unrecognisable in many runs |

**Exit codes and sentinels together** establish the phase. **Only the text** explains the
cause. "Dependency installation failed" is true but useless; "a native module ships no
arm64 build" tells you what to do next.

## Why phase attribution needs both

The wrapper `exec`s the start command, replacing itself so signals reach the application.
That is correct for shutdown, but it means the container's exit code belongs to the app.

An application exiting `110` of its own accord must not be reported as a dependency
install failure just because `110` is the wrapper's install-failure code. So wrapper exit
codes are consulted **only while the wrapper still owns the process** — that is, when the
`START` sentinel has not been seen.

## Taxonomy

22 codes. The original plan defined 14; five were added from things that actually
happened during the build, one (`CONTAINER_CREATE_FAILED`) from a setup failure mode, one
(`APPLICATION_EXITED`) once sessions started re-checking liveness after readiness, and one
(`DOCKER_SOCKET_REQUIRED`) the first time a repository that drives Docker was run.

| Code | Meaning |
|---|---|
| `MISSING_ENV` | Required configuration absent |
| `WRONG_RUNTIME_VERSION` | Runtime version unavailable |
| `DEPENDENCY_INSTALL_FAILED` | Install step failed |
| `BUILD_FAILED` | Build step failed |
| `START_COMMAND_FAILED` | The application failed to start |
| `PORT_NOT_LISTENING` | Nothing bound the expected port |
| **`PORT_BOUND_TO_LOCALHOST`** | Listening on loopback, unreachable through Docker |
| `APPLICATION_UNHEALTHY` | Health expectations not met |
| `READINESS_TIMEOUT` | Port open, no HTTP response in budget |
| `DATABASE_REQUIRED` | Needs an external database |
| `NETWORK_FAILURE` | External network operation failed |
| `PROCESS_TIMEOUT` | Exceeded its budget |
| `UNSUPPORTED_PROJECT` | No plan could be produced |
| `INVALID_AI_PLAN` | Model returned invalid structured output |
| **`PLAN_REJECTED_UNSAFE_COMMAND`** | Structurally valid plan, disallowed command |
| **`ARCH_INCOMPATIBLE`** | x86-only dependency on arm64 |
| **`REPOSITORY_TOO_LARGE`** | Exceeded intake caps |
| **`OUT_OF_MEMORY`** | Killed for exceeding the memory limit |
| **`APPLICATION_EXITED`** | Died *after* it had become ready |
| **`DOCKER_SOCKET_REQUIRED`** | Drives Docker itself; the sandbox withholds the daemon |
| `CONTAINER_CREATE_FAILED` | Working directory missing inside the container |
| `UNKNOWN_RUNTIME_ERROR` | Not confidently classifiable |

### Why these additions earned their place

**`PORT_BOUND_TO_LOCALHOST`** is the most common real failure and the reason this
taxonomy needed extending at all. Vite, Flask and Django all bind `127.0.0.1` by
default. Inside a container that makes Docker's port mapping resolve to nothing — a
**perfectly healthy application, completely unreachable**. Reporting it as
`PORT_NOT_LISTENING` sends you debugging a server that is running fine. The remedy is
entirely different: bind `0.0.0.0`.

**`OUT_OF_MEMORY`** matters because on a 1 GB container ceiling a React install reaches
it routinely, and the remedy is a configuration change rather than a code fix. Folding it
into `DEPENDENCY_INSTALL_FAILED` would hide the one useful fact.

**`ARCH_INCOMPATIBLE`** exists because development targets Apple Silicon and v1 does not
emulate. Without it these land in `UNKNOWN_RUNTIME_ERROR` with a cryptic
`Exec format error`.

**`APPLICATION_EXITED`** is the only code that describes something going wrong *after*
success. `START_COMMAND_FAILED` would be actively misleading here: the command was right,
it ran, and it served traffic. Nothing about the plan needs changing, so the remedy points
at the end of the log rather than at the planner — and unlike every other code in this
table, it is never repairable, because there is nothing in the plan to repair.

**`DOCKER_SOCKET_REQUIRED`** is the only code here that no configuration can fix. Every
other failure names something the user could supply, change or retry. This one says the
project cannot run inside a container that withholds the Docker socket — and withholding
it is the point, since mounting it would hand any repository root on the host. The honest
answer is "run this on your machine", and a verdict that says so beats one that reports a
port never opening.

### Readiness starts when the application does

Install and build run inside the container before the start command is `exec`'d, so a
readiness clock started at container start is measuring the wrong thing. A project with a
large dependency tree — pip resolving for minutes — was reported as `PORT_NOT_LISTENING`
before it had been asked to listen, and then *repaired*, re-running the same install from
scratch each time.

Readiness now waits for the `START` sentinel, bounded by the time-to-ready budget. An
install that never finishes within it is reported as `PROCESS_TIMEOUT` against the
install or build phase, with the budget named in the remedy.

### Symptom versus cause

`PORT_NOT_LISTENING` describes what DevLaunch observed. When the application is still
running — `tsx watch` and every other watcher survive a crash in the code they watch — the
log usually names why, and a cause beats a symptom, so that branch is classified against
the log before reporting. A loopback-only bind is not: it is read from the container's own
socket table, and a log line should not be able to overrule a measurement.

## Liveness after readiness

Readiness is a measurement taken once, not a promise that holds. An application can
answer a request and then crash, get OOM-killed, or have its container removed from
underneath it.

A `READY` session therefore re-checks its container every five seconds
(`DEVLAUNCH_TIMEOUT_LIVENESS_MS`) and ends when it is gone. Three rules govern that check:

- **Only a definite answer ends the session.** "I could not inspect the container" is not
  evidence that an application died. Treating a busy Docker daemon as a dead application
  would be a worse failure than the one this catches.
- **A clean exit is completion, not failure.** A server that returns `0` shut itself down.
- **An OOM kill is told apart from an ordinary crash.** Both surface as exit `137`, and
  the kernel's `SIGKILL` means the process writes nothing on its way out — so the log
  classifier has no signature to match and `State.OOMKilled` is the only evidence left.

## Signature matching

13 signatures, ordered **most specific first**. Each carries patterns, the phases it can
apply to, and a remedy.

Ordering is load-bearing: `ECONNREFUSED 127.0.0.1:5432` is a **missing database**, not a
generic network failure. A broad network rule placed first would swallow it and send the
user to check connectivity instead of the real answer.

The **last** matching line wins. Errors accumulate, and the final one is usually the
cause rather than a consequence.

## Three rules for every verdict

1. **It carries its evidence.** The matching log line is attached, so a diagnosis can be
   checked rather than trusted. A wrong verdict becomes visible instead of convincing.
2. **It carries a remedy.** A classification with no suggested action is half a
   diagnosis.
3. **It admits uncertainty.** Where no signature matches, the coarse verdict is returned
   marked `confidence: 'low'` and displayed as *uncertain*. Saying "I do not know why"
   beats inventing a cause that reads convincingly and sends someone down the wrong path.

`exit 137` with no explanatory output is treated as OOM at **medium** confidence — the
kernel's OOM killer gives the process no chance to explain itself, so the inference is
reasonable but not evidenced.

## ANSI stripping is part of classification

Escape sequences are stripped at **ingestion**, not at render time. A line arriving as
`ESC[31mERROR: ...` silently fails a signature anchored on `ERROR`, and the diagnosis is
lost. Stripping early means the buffer, the classifier and the display all see the same
clean text.

## Not correctness

READY means an HTTP server accepted a connection and returned a complete response. It
does **not** mean the application works, that its routes behave, or that its data layer
is healthy. A configured health-check status is surfaced as a hint and never gates a run.
