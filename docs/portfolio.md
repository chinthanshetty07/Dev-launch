# DevLaunch — project write-up

## The problem

Running an unfamiliar GitHub repository is surprisingly manual. You have to work out the
language, the framework, the runtime version, the package manager, the install command,
the start command, the environment variables, and the port. Then when it fails, you read
the logs and work out why.

Most of that is *already written down* — in `package.json`, in lockfiles, in
`requirements.txt`, in framework config. It just isn't read.

## What DevLaunch does

Give it a public GitHub URL. It clones the repository, reads its manifests, derives a
structured run plan, executes that plan inside a hardened container, verifies the
application actually responds, streams the logs, and — when something goes wrong —
explains what and suggests a fix.

## The architectural decision that matters

The obvious build is "send the repo to an LLM and ask how to run it." I did not build
that, and the reason is the most interesting part of the project.

**Detecting a known project type from `package.json` is a solved, deterministic
problem.** Using a language model for it adds cost, latency, and non-determinism to
something a lookup table does perfectly. So the primary path is a table of **22
detectors** — Next, Nuxt, SvelteKit, Astro, Remix, Gatsby, Docusaurus, Angular, Vue CLI,
CRA, Vite, Parcel, Webpack, NestJS, Fastify, Koa, Express, Django, Flask, FastAPI,
Streamlit, Gradio — plus a generic fallback. Zero model calls, zero cost, same answer
every time.

A model earns its place in exactly two situations: a repository matching no known
pattern, and interpreting unstructured failure logs. Both are genuinely poor fits for
rules and good fits for a language model.

And whichever produced a plan, it passes through the **same validator** and runs in the
**same sandbox**. The model never decides whether something worked.

> Deterministic rules handle what they can. AI handles what they cannot.
> The sandbox executes. The verifier decides.

## Systems engineering

**Isolation.** Containers run non-root with all Linux capabilities dropped, a read-only
root filesystem, a writable volume for the workspace only, `no-new-privileges`, memory,
CPU and PID ceilings, a hard timeout, and no Docker socket. Egress to RFC1918,
link-local and the VM host is blocked by iptables rules in two chains.

Every one of those is asserted by an integration test that reads what the **kernel**
reports from inside a live container — `CapEff`, cgroup limits, actual write attempts —
rather than what Docker was configured with. A security claim nothing verifies is a
comment.

**Observability.** Container output is demultiplexed, ANSI-stripped, sequence-numbered
and streamed to the browser over a WebSocket. A client that drops its connection resumes
from exactly where it left off; if the lines it missed have aged out of the bounded
buffer, it is told so explicitly rather than handed a stream with a silent hole.

**Reliability.** Twenty failure categories, each carrying the log line that produced the
verdict and a suggested remedy — and, where nothing matches, an honest admission that
there is no diagnosis rather than a plausible-sounding invention.

## Three problems that turned out to be the actual work

### Healthy applications that are completely unreachable

Vite, Flask and Django all bind `127.0.0.1` by default. Inside a container, Docker's port
mapping then resolves to nothing. The application is running perfectly and is completely
unreachable — and reporting that as "port not listening" sends you debugging a server
that is fine.

So the planner **rewrites start commands** to force `0.0.0.0`, per framework, with the
right flag syntax for each. And when an application ignores that anyway, readiness reads
the container's own `/proc/net/tcp`, sees a socket bound to loopback, and reports
`PORT_BOUND_TO_LOCALHOST` with the actual remedy.

This is the single most common real-world failure for a tool like this, and it was not in
the original plan at all.

### "Started" and "ready" are different facts

A container can run happily while the application inside never opens a socket. Equally, an
app that returns `404` on `/` or redirects to `/login` is working fine — gating readiness
on a 2xx status would fail most real APIs.

So readiness means *a server completed an HTTP response*, any status. The configured
status code is recorded as a hint and never gates a run.

### Ordering is load-bearing, in two places

SvelteKit, Astro, Nuxt and Remix all depend on Vite. Check for Vite first and you
misidentify all three — wrong port, wrong dev server, confident and wrong.

The same shape appears in failure classification: `ECONNREFUSED :5432` is a missing
database, not a generic network error. A broad rule placed first swallows the specific
one.

Both tables are ordered most-specific-first, and both have a test that fails if that
ordering breaks.

## What I would tell an interviewer

> "I noticed that running an unfamiliar GitHub repository is oddly manual — you have to
> work out the runtime, the package manager, the start command, the environment
> variables and the port, and when it fails the error is often opaque.
>
> DevLaunch automates that. For project types I understand — 22 of them — the run plan is
> inferred deterministically from the project's own metadata. No AI call, no cost, no
> non-determinism. A model is only involved when a repository matches no known pattern,
> or when something breaks and messy logs need interpreting.
>
> The key architectural decision was deciding *where AI actually earns its place*.
> Detecting Vite from `package.json` is a solved problem — using an LLM for it would just
> add cost and unpredictability. Diagnosing a failure from unstructured output is exactly
> where a language model is useful.
>
> The part I found most interesting wasn't the AI at all. It was that most of the real
> failures are boring and specific: frameworks binding loopback so Docker can't reach
> them, Angular rejecting requests whose Host header it doesn't recognise, Streamlit
> blocking forever on a first-run email prompt. Encoding those is what makes it actually
> work, and none of it was in my original plan — it came out of watching real projects
> fail."

## Honest limitations

Stated plainly, because a portfolio project that overclaims is worse than one that
doesn't:

- **Egress is open to the internet**, because package installs need registries.
  Restricting it properly needs a MITM proxy.
- **Repository scripts are not inspected.** The container is the security boundary, not
  the planner, and the docs say so rather than implying otherwise.
- **arm64 only.** No emulation.
- **No database provisioning**, so projects needing Postgres are detected and reported,
  not run.
- **One session at a time**, bounded by an 8 GB development machine.
- **Sessions are in-memory.** Restarting the backend loses them, which is correct for a
  single-user local tool.
- **AI is not implemented in v1.** The interface is defined and the default refuses
  loudly, so the fallback is additive rather than a rewrite.

## By the numbers

- ~8,000 lines of TypeScript across backend, frontend and a shared contracts package
- **294 tests**, of which roughly 70 are security tests and 40 drive real containers
- 22 deterministic detectors; 13 failure signatures; 20 failure categories
- 16 vendored fixtures, each reproducing exactly one behaviour

## In ten seconds

```
DEVLAUNCH =
  GitHub URL
+ Repository analysis
+ Deterministic plan generation   (AI only for the unrecognised)
+ Hardened Docker isolation
+ Port mapping + readiness verification
+ Real-time log streaming
+ Failure diagnosis with evidence
```
