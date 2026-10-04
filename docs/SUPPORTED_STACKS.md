# Supported stacks

What DevLaunch can deploy today, measured on 40 real public repositories (`scripts/corpus`)
and on the fixtures in `fixtures/`. "Supported" means a rule plans it — no model needed.

## Runtimes

| Runtime | Image | Chosen when |
|---|---|---|
| Node 20 | `devlaunch/node:20` | default for JavaScript/TypeScript |
| Node 22 | `devlaunch/node:22` | `engines.node` needs it, or a `node:` built-in only 22 has |
| Python 3.12 | `devlaunch/python:3.12` | any Python project |

**Not supported yet:** Java (Maven, Gradle), Go, Rust, PHP, Ruby, .NET, Elixir, Deno, Bun.
A repository whose only manifest is one of theirs is declined at once, naming the runtime —
never planned by guesswork. Each needs a hardened runner image and a planner.

## JavaScript / TypeScript

Vite (React, Vue, Svelte, Preact…), Create React App, Next.js, Nuxt, Remix, Astro,
SvelteKit, Angular, Vue CLI, Gatsby, Docusaurus, Parcel, webpack-dev-server, Express,
Fastify, NestJS, Koa, plain `node` entry files, `ts-node`/`nodemon` dev servers, static
sites.

- **Package managers:** npm, pnpm, Yarn 1 and Yarn 2+. With a lockfile the install is strict
  (`npm ci`, `--frozen-lockfile`, `--immutable`); a lockfile that disagrees with
  `package.json` is relaxed once, by rule.
- **Monorepos:** npm, pnpm and Yarn workspaces, Turborepo layouts; one install at the root,
  shared by the services that need it.

## Python

Flask (including app factories), FastAPI (including HTTPS with the repository's own
certificate), Django (with `migrate`), Streamlit, Gradio. Installs from `requirements.txt`,
`pyproject.toml` (with the declared version ranges), or the imports when nothing is declared.

## Several services

A frontend, an API and workers in one repository are found from compose files, workspace
manifests and directory layout, and started together: each on its own port, each told the
others' addresses under the variable names it reads, with its own health and logs.

## Databases and services

| | Provisioned | Detected from |
|---|---|---|
| PostgreSQL | ✓ | drivers, ORMs, connection strings, compose |
| MySQL | ✓ | same |
| MongoDB | ✓ | same |
| Redis | ✓ | same |
| SQLite | needs nothing | |
| RabbitMQ, Kafka, Elasticsearch, MinIO | ✗ | reported as a missing dependency |

Migrations: Django's `migrate` and a repository's own schema script. Prisma, Alembic,
Sequelize and TypeORM migrations are not run yet.

## Never used

A repository's own `Dockerfile` or `docker compose up`. Both would run the repository's
instructions with Docker's own privileges, outside DevLaunch's sandbox and network
policy — see `SECURITY.md`. Compose files are read as a declaration of services, ports,
images and environment.
