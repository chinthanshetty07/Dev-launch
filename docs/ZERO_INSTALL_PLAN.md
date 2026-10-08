# Plan: paste a link, get a running project — with no install step

**Written:** 2026-10-08 · **Status:** proposal, nothing built yet

## The goal, in the user's words

> "cut the manual deployment work and user pastes a repo link and what he gets is a fully
> end to end locally running project"

Today a person runs one install command, then pastes links into DevLaunch on their own
computer. The goal is to drop that install step entirely.

## The one fact that shapes everything

A project has to run **on some computer**:

- **On the person's own computer** — then DevLaunch (and Docker) must be on that computer.
  A website cannot install software on a visitor's computer; every browser blocks it, so
  that strangers' sites cannot. The install can shrink to **one download and one click**,
  once — never to zero.
- **On a computer somewhere else** — then nothing is installed by the person. The project
  runs over there, and they get a link to it (like a preview). It is not on their computer.

So "no install at all" means "it runs somewhere else". The three designs below differ in
**where** that is, and **who pays and carries the risk**.

---

## Option A — GitHub Codespaces: zero install, runs in the person's own free cloud space

**How it feels:** on the DevLaunch website, the person pastes a link and clicks **Run**. A
GitHub page opens ("Create codespace"), they click once, and in a minute or two they get a
link to the running project. Nothing installed on their computer.

**How it works:** GitHub Codespaces gives every GitHub account free cloud computers (about
60 hours a month on the smallest size). The DevLaunch repository gets a `.devcontainer`
setup: Docker inside, DevLaunch pre-installed, its runner images pre-built. The website's
Run button opens a codespace of DevLaunch with the pasted repository passed along; DevLaunch
starts it, and GitHub gives the running app a private web address.

| | |
|---|---|
| Install for the person | none — a GitHub account (free) |
| Cost to you | none — each person uses their own free GitHub hours |
| Abuse risk to you | none — it runs in *their* GitHub account, under GitHub's rules |
| Runs on their computer? | no — in their own cloud space; they open a link |
| Work | ~1–2 weeks |

**Risks to check first (a short spike, 1–2 days):** DevLaunch's safety guard changes the
firewall inside Docker; inside a codespace that is Docker-in-Docker, which may need
adjusting. Codespaces' smallest machine (2 cores, 8 GB) runs one project at a time, which is
DevLaunch's default anyway. A first start takes 1–3 minutes while images download (GitHub can
keep a pre-built codespace ready to cut this to seconds).

---

## Option B — your server: zero install, runs on a computer you host

**How it feels:** the person pastes a link on your website and gets a link to the running
project. No account, nothing installed.

**How it works:** DevLaunch runs on your server; each pasted repository runs there in its
own sandbox; each gets a public address.

| | |
|---|---|
| Install for the person | none |
| Cost to you | **real**: every visitor's project uses your server's CPU and memory. A free server (e.g. Oracle's ARM, 4 cores / 24 GB) runs roughly 5–10 small projects at once |
| Abuse risk to you | **high**: strangers' code runs on your server and your account. Crypto mining, spam and phishing pages are certain; free providers ban accounts for them |
| Runs on their computer? | no — on yours |
| Work | ~6–10 weeks: the full hosting plan (`docs/HOSTING_PLAN.md`) — logins or strict limits, a second sandbox wall (gVisor), public HTTPS addresses, abuse detection, monitoring |

This is the hosted service designed earlier and set aside. It is the only option where you
carry the cost and the risk.

---

## Option C — a desktop app: one download, then truly local, click-to-run forever

**How it feels:** first time, the website says **Download DevLaunch** (Mac, Windows, Linux).
The person double-clicks it once; it installs everything (Node built in, Docker set up). From
then on, the website's **Run on my computer** opens their DevLaunch directly — even starting
it — and the project runs on their own computer.

| | |
|---|---|
| Install for the person | one download + one double-click, once |
| Cost to you | none |
| Abuse risk to you | none |
| Runs on their computer? | **yes** |
| Work | ~3–5 weeks. Mac and Windows show an "unknown developer" warning unless you buy signing certificates (Apple $99/year; Windows ~$100–300/year) |

---

## Comparison

| | A: Codespaces | B: your server | C: desktop app |
|---|---|---|---|
| Install step for the person | none | none | one click, once |
| Needs an account | GitHub (free) | no | no |
| Runs on their own computer | no | no | **yes** |
| Your cost | none | servers, bandwidth | certificates (optional) |
| Your abuse risk | none | **high** | none |
| Time to build | 1–2 weeks | 6–10 weeks | 3–5 weeks |

## Recommendation

1. **Build A first.** It gives exactly "paste a link, get a running project, nothing to
   install", costs you nothing, and puts no strangers' code on your accounts. Start with the
   1–2 day spike that proves DevLaunch's sandbox works inside a codespace.
2. **Then C**, for people who want projects on their own computer.
3. **B only** with a budget for servers and time for abuse handling — and after A shows how
   many people actually use it.

The current one-line install stays, for developers who prefer it.

## Decision needed

Which to build: **A**, **B**, **C**, or an order of them.
