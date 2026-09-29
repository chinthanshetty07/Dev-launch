# Failure model

An execution that fails is not an error to be logged — it is a result to be explained.
This document describes how DevLaunch decides *what went wrong*.

## A missing module is two failures wearing one sentence

`Cannot find module 'express'` is a dependency: installing it is a plan change a rule
can make. `Cannot find module './routes/users'` in a repository whose file is `users.js`
at the root is the repository being wrong about itself, and no plan reaches it. The
second is `BROKEN_IMPORT` and non-repairable; conflated, it cost a model call per
occurrence, and the model answered by inventing `npm run serve`.

The distinction is the leading dot, and it is narrower than it first looks. Node reports
a `require` exactly as written, and resolves a *command-line entry* to an absolute path
first — so `node wrong-entry.js` fails with `'/workspace/wrong-entry.js'`, which is the
plan naming the wrong file and is precisely what repair is good at. An early version of
this rule claimed absolute paths too and took that fix away; an integration test that had
exercised it for months is what said so.

## The runner's epilogue is not a diagnosis

`error Command failed with exit code 1.` is yarn restating the exit code, and it is the
last line of the log — so it became the evidence for a real repository's failure, under a
heading that already said the command exited 1. `Node.js v20.20.2` is the same thing in
Node's voice, and it is the final line of every Node crash there is.

These are epilogues: true, not news, and printed after the thing worth reading. Walking
past them turned one real failure's report from a version number into
`code: 'SQLITE_CANTOPEN'`. Skipping noise must not become withholding evidence, so when
the epilogue is genuinely all there is, it is still quoted — at low confidence.

## A plan is checked for whether it is possible

The validator asked whether a plan was well-formed and whether it was safe, and never
whether the repository could run it. So `npm run serve`, against a manifest defining
`start` and `dev`, built a container and installed a dependency tree before failing.

`Feasibility` compares a plan's commands against the manifest's script names and refuses
the run in a second, naming the scripts that do exist. Deliberately narrow: it reports
only what it can prove from a manifest it has, and `yarn start`, `yarn test` and
`yarn build` are exempt because the word alone cannot say whether they mean a script or
the package manager's own verb. A missed check costs a minute; a wrong one refuses a plan
that would have worked.

## Stopping is not failing

`cancel` removes the containers and sets the state; the pipeline step that was mid-install
knows none of it. It used to carry on, find its container gone and report a crash — so a
run stopped at `WAITING_FOR_READY` answered `CANCELLED` and then, five seconds later, said
the project had failed with `UNKNOWN_RUNTIME_ERROR`. Pressing Stop told you your project
had crashed.

Two things fix it, and the obvious one is not enough. A guard refusing to leave a
*terminal* state gets it exactly backwards: a stop passes through `CLEANING_UP`, which is
not terminal, so the resuming step still reached `fail` — and `FAILED`, arriving first,
became the terminal state that blocked `CANCELLED`. What matters is not whether a session
has finished but whether somebody asked it to, so `stopped` is set before teardown and
only the states a stop itself passes through may follow it.

That makes the *state* safe. The *work* is stopped separately, at two places: the gate
immediately before a container is created, and the entry to repair — which would otherwise
spend a model call diagnosing a run nobody is waiting for.


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

## Evidence is the last thing the application said

A failure quotes a line from the application's own output, and which line it quotes is
most of the report's value. Two rules, both learned from failures that reported nothing
useful:

**An errno pattern must be matched case-sensitively.** `\bE[A-Z]{3,}\b` exists to catch
`ENOENT` and `EADDRINUSE`. Carried under the `/i` flag it also catches `extensions`,
`elapsed` and `existing` — so pip's "Successfully installed typing-extensions…" was
quoted as the error behind a failure, in preference to the line that said what broke.

**When nothing looks like an error, quote the last line anyway.** A process that never
opened its port has usually not errored; it is waiting. `PORT_NOT_LISTENING` with no
evidence reads `Nothing is listening on port 8000. Sockets observed: 127.0.0.11:37497.`,
which is true and tells nobody anything. The last line it printed before going quiet —
`INFO: Waiting for application startup.` — is the entire diagnosis.

A server that announced it was starting and never announced it had started is called out
specifically, because its remedy is different from every other way of not listening: the
port was never opened because startup never *finished*, and the thing to look at is
whatever the application connects to at boot.

## The reported diagnosis is the first one, and says so

When repair runs and fails, the failure reported is the one taken *before* any repair.
The first diagnosis describes the repository as the user wrote it; every later one
describes a plan the model invented, and letting those overwrite it makes the reported
cause depend on model output — an application that plainly bound loopback could be
reported as failing to start.

The cost is that the plan shown on the dashboard is then not the plan the failure came
from. A real session displayed a start command reading `uvicorn --port 8080` beside
*Nothing is listening on port 8000*. Both were correct: 8000 was the planned port that
failed, 8080 was what repair invented afterwards. Nothing on screen connected them, and
two numbers that cannot both be right is how a tool teaches someone to stop reading it
and retry blindly instead — which is exactly what happened, six times.

So a retained diagnosis now carries `repairAttemptsAfter`, and the dashboard says plainly
that the diagnosis describes the first attempt and the plan above has since been
rewritten. The repair attempts themselves are on the session, rather than being visible
only in the log.

## A placeholder in .env.example is a request, not a default

`OPENAI_API_KEY=sk-your-key-here` is the author saying where yours goes. Counted as a
value it meant the gate asked for nothing, the container started without the variable,
and the application died at import with *Missing credentials … set the OPENAI_API_KEY
environment variable* — the exact failure the gate exists to prevent, on a repository
that had documented the variable perfectly. The recogniser is deliberately narrow:
`<your-token>`, `your_secret_here`, `changeme`, `xxxxxxxx`, `${VAR}` and the
`sk-your…` family match; `development`, `localhost`, `5000`, `info` and `gpt-4o-mini`
are real defaults and must stay that way.

The missing-configuration signature also matches the reverse word order — *set the
`X` environment variable* — which is how the OpenAI SDK phrases it. It had been landing
as a low-confidence generic start failure with the variable's name in plain sight.

## Repair is decided by policy, attempted by rule, and only then by model

Every failure used to be a generic AI repair task with two retries. The policy
(`RepairPolicy`) now decides from the failure class alone: a missing secret, an outage,
a memory ceiling or a plan the model already got wrong stops at once, with the reason in
the log. Where a rule can have evidence (`DeterministicRepair`) it gets the first
attempt and spends no model call — it quotes the manifest or log line that justified
it, and proposes nothing without one, which is what makes it safe to run first. A model
is asked at most once per failure class, after. Every repair is a typed record on the
session: what changed, why, and which of the two decided it.

## `python: not found` is the image, not a system library

`sqlite3@5.0.2` unpacks its amalgamation from a Makefile with a bare `python`. node-gyp
finds `python3` on its own, so the toolchain check passes and the compile then dies with
`/bin/sh: 1: python: not found`, exit 127. The generic native-build rule matched the
`gyp ERR!` that followed and sent people after a missing system library. The runner
image now ships `python-is-python3`, and the line is its own signature.

## Exiting 0 is not a failure

Readiness watches for a port. A repository that never opens one — a CLI, a migration, a
seeder, a scraper, a build script — exits 0 having done exactly its job, and the
readiness path reported `UNKNOWN_RUNTIME_ERROR: container exited before becoming ready`,
confidence low, no evidence, no remedy. A working program described as broken, in the
least actionable words available. `runToCompletion` had always classified exit 0 as
`COMPLETED`; only the readiness path, which cannot tell "finished" from "died" by
watching a socket, did not.

A clean exit before readiness is now `COMPLETED`. The session says what happened — it
ran, it finished, it never opened a port, and that is the expected shape for a script —
and no repair is attempted, because there is nothing wrong to repair.

**Unless DevLaunch planned a server.** A plan with `hostBinding: 'forced'` is one where a
framework was recognised and told where to listen, and a dev server that stops with 0
before opening that port has stopped rather than finished. Reported as `COMPLETED`, it hid
a Create React App dev server closing on an empty stdin — about a plan built to serve port
3000 — under a sentence calling it the expected shape for a script. It is now
`APPLICATION_EXITED`, "finished successfully instead of serving", with the last line the
process printed and no repair: the command was the right one, and the reason is in the
log. A script, a CLI or an entry file DevLaunch could not bind is still `COMPLETED`.

## A pyproject.toml is not a promise of a buildable package

`pip install .` failed with setuptools' own refusal — *Multiple top-level packages
discovered in a flat-layout: ['app', 'certs', 'resources']* — and repair then guessed
`pip install -r requirements.txt` on a repository that has no such file. Two failed
installs, and the dependencies had been declared in pyproject.toml the whole time.

That layout is an ordinary application: code beside its certificates and its assets.
Setuptools will not guess which directory is the distribution, and it is right not to.
The project is not a package; its dependencies are still installable.

Packageability is predicted, not discovered by failing, because setuptools' rule is
short and documented: explicit `packages`/`py-modules` configuration settles it, a
`src/` layout settles it, and otherwise auto-discovery fails when more than one
top-level directory survives its exclusion list. When the answer is no, the declared
dependencies are installed with the version ranges pyproject.toml gives them, through a
requirements file DevLaunch writes into the container at launch (below). A deterministic
repair rule catches the variants prediction misses, the same way, at no model call.

They used to be installed by name, because the command allowlist permits no `<`, `>` or
quotes and a range cannot be written on a command line. By name, `pydantic = "^1.9"`
installed pydantic 2, and code written for 1 died on `BaseSettings has moved`. A file
needs no quoting. Its lines are rebuilt from a name, extras and version clauses, and held
to a pattern that cannot express an option — a requirements file obeys `--index-url`,
`-e` and `-r` — with anything else falling back to the bare name it would have had before.
Its content is derived from the repository when the container is created, never carried
by a plan, so a plan naming the file cannot choose what is in it.

## The kernel's answer beats the log's claim

`PORT_NOT_LISTENING` used to mean one thing: nothing was bound to the port the plan
expected. Its message said so — `Nothing is listening on port 3000. Sockets observed:
127.0.0.11:36213, ::1:8017.` — and it was true and useless. The process had opened 8017
and said so in its own log, and the only responder that noticed was a model guessing at a
new start command. It guessed twice, and its second guess was a script the manifest does
not contain.

`PortManager.diagnose` now reports a fourth kind, `other-port`: open, reachable, and not
where the plan expected. Two things make it an answer rather than a guess.

- **Docker's embedded DNS is excluded.** `127.0.0.11` listens in every container on a
  user-defined network. Counting it turns "one socket, on the wrong port" into "several
  sockets", which is not an answer.
- **Only one socket qualifies.** Two open ports and no way to tell which is the
  application is a guess, and this reports nothing rather than guess.

The socket travels with the failure as `observedSocket`, a typed field rather than prose,
so the repair rule acts on it without parsing English. It is the strongest evidence about
a port there is: not a framework default, not a log line's claim, but what the kernel says
the process bound. The rule corrects the port *and* the bind address in the same attempt
when both are wrong — fixing one and rediscovering the other is how a session spends two
attempts on one problem.

The log-reading rule is still there, one place further down, for the case where the
container is gone before its socket table could be read. Its patterns were widened: one
real repository prints `I am running at localhost:8017/`, and every pattern required
`http://` before the host.

## A literal in the source is not a plan problem

`app.listen(port, 'localhost')` cannot be changed by any environment variable, any flag,
or any rewritten start command. Repair could only spend its attempts proving that — first
a rule forcing `HOST=0.0.0.0` the application never reads, then a model inventing a start
command — at a full reinstall each.

The analyzer reads it before the run: `hardcodedBind` carries the file and the line. The
planner warns while the plan is still on screen, the diagnosis carries the exact edit as
its remedy, and repair declines with the reason in the log. An honest failure that names
the line arrives minutes sooner than two doomed attempts.

The remedy is attached where the diagnosis is taken, not where repair declines. The
reported failure is deliberately the *first* one, so anything added later to a copy of it
is discarded when the original is restored.

## One runtime version means a version mismatch is not repairable

`WRONG_RUNTIME_VERSION` was `DETERMINISTIC` with one model call, on the theory that a
manifest might name a version an approved image can satisfy. The allowlist carries exactly
one image per language, so `runtime.version` has nowhere else to point and no rewritten
plan reaches a runtime that does not exist. A test holds the two in step: approving a
second version makes the failure repairable again, and that test is what will say so.

Three signatures now classify here, and each one was a real repository that spent a model
call arriving where it started:

- `No module named 'imp'` (and `distutils`, `cgi`, and the rest removed in 3.12) — a
  dependency written for a Python that still had them.
- `No module named 'pkg_resources'` and `'build_ext' object has no attribute
  'cython_sources'` — a pinned dependency with no wheel for 3.12, whose source build does
  not work there either. `--only-binary` cannot help: pip would have taken a wheel if one
  existed.

## An error that names its own remedy

`pg_config is required to build psycopg2 from source` is followed, in pip's own output, by
"If you prefer to avoid building psycopg2 from source, please install the PyPI
'psycopg2-binary' package instead." Acting on that sentence is not inference.

The substitution cannot be made any other way — the file is the repository's, and
`-r requirements.txt` will always install what it says — so the same list is installed by
name with one entry changed. `requirementsAsArguments` returns null rather than an
approximation whenever a line cannot be reproduced faithfully: a URL, a VCS reference, an
`-e .`, another `-r`, an environment marker, an extras bracket. Dropping one silently
would install a different set of packages than the repository asked for and call it a
repair. `==` survives because the allowlist permits it; `>=` collapses to the bare name,
which the evidence states rather than hides.

## A registry certificate is the network, not the repository

`error Error: certificate has expired` from a package registry is a property of the
network and of the runner image's certificate store. It was classified as a dependency
install failure and repaired twice, each attempt re-running the same download against the
same certificate.

## A runtime can be too new, and a newer one is no answer

`WRONG_RUNTIME_VERSION` is repaired by moving to the next newer approved image, which is
right for a built-in the running Node lacks. It is wrong for webpack 4, whose `md4` hash
OpenSSL 3 removed: `ERR_OSSL_EVP_UNSUPPORTED` on Node 17 and later, so on 22 exactly as on
20. That failure used to be `START_COMMAND_FAILED` at low confidence, and a model was
asked; its one idea was `NODE_OPTIONS=--openssl-legacy-provider`, which the validator
refuses from every plan by design.

It is now `WRONG_RUNTIME_VERSION` with `runtimeDirection: 'older'` — a typed field, like
`observedSocket`, which a signature attaches through its `detail` — and the repair rule
declines on it. With the policy allowing no model call for this code, the run stops with
the diagnosis and a remedy that says which toolchain to upgrade.

## A phase is explained by its own output

Sentinels never enter the log buffer, so for a long time the log could not say which
phase a line belonged to, and every classification read all of it. A start that failed
was then explained by whatever the install had printed: husky's `git command not found`,
from a `prepare` script during an install that went on to succeed, was reported as the
reason `ng serve` would not run; npm's `EBADENGINE` *warnings* for transitive packages
became `WRONG_RUNTIME_VERSION`, and a repair was spent moving the run to Node 22, where it
failed the same way on a missing `.env`.

`LogManager` now remembers where each sentinel fell, and a failure is classified against
the log from its phase's opening marker — as are the "last thing the application said"
helpers, which describe a running application and not the install before it. The latest
marker wins, so a repaired attempt writing into the same session log is divided by its
own.

A signature can also name lines that are never its evidence. Package managers warn and
fail in nearly the same words — `npm warn EBADENGINE` and `npm error code EBADENGINE` —
and only one of them stops anything. pnpm's fatal form, `ERR_PNPM_UNSUPPORTED_ENGINE`,
was not recognised at all, which cost a model call on a failure the deterministic Node
22 move exists for.

## An unclassified failure still quotes the application

When no signature matches, the verdict stays the coarse fallback at low confidence —
admitting there is no diagnosis beats inventing one. But that was previously implemented
as reporting *nothing else either*, and the result was a failure panel reading, in full,
`Start command exited with code 1.` on a run whose log ends
`RuntimeError: Working outside of application context.`

Withholding a verdict is honesty. Withholding what the program said is silence. The last
meaningful line now travels as evidence, marked low-confidence like the verdict it sits
beside, and the search prefers an exception line — `RuntimeError: …`,
`sqlalchemy.exc.IntegrityError: …` — over the paragraph some runtimes print after it.
Flask's continues for three lines past the exception and ends "See the documentation for
more information.", which is true and says nothing.
