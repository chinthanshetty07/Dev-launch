# Supported stacks

What DevLaunch can deploy today, measured on 40 real public repositories (`scripts/corpus`)
and on the fixtures in `fixtures/`. "Supported" means a rule plans it — no model needed.

## Runtimes

| Runtime | Image | Chosen when |
|---|---|---|
| Node 20 | `devlaunch/node:20` | default for JavaScript/TypeScript |
| Node 22 | `devlaunch/node:22` | `engines.node` needs it, or a `node:` built-in only 22 has |
| Python 3.12 | `devlaunch/python:3.12` | any Python project (the default) |
| Python 3.13 | `devlaunch/python:3.13` | a project that requires it: `requires-python`, `.python-version`, `runtime.txt`, requirement markers or its Dockerfile |

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
| RabbitMQ, Kafka, Elasticsearch, MinIO | as a compose service | only when the repository's compose file runs it (the Docker fallback); not detected otherwise |

Migrations: Django's `migrate` and a repository's own schema script. Prisma, Alembic,
Sequelize and TypeORM migrations are not run yet.

## Anything else with a Dockerfile or compose file

When no rule plans a repository — Go, Java, PHP, Rust, .NET, Ruby, Elixir, or a layout
nothing reads — and it ships a `Dockerfile` or a compose file, DevLaunch builds and runs
*that*, as a fallback: built off the local network, run under the balanced profile, checked
end to end like any other run (`SECURITY.md`). A compose file's databases and brokers
(Postgres, MySQL, MongoDB, Redis, RabbitMQ, Kafka, Elasticsearch, MinIO…) start as the
images it names, in `depends_on` order, and are waited for until they accept connections.
Refused, with the setting named: anything that needs privileges, host files or networks,
or the Docker socket. Fixtures: `docker-go-api`, `docker-compose-stack`, `docker-refused`,
`docker-breakout`.

A repository DevLaunch runs its own way never takes this path, Dockerfile or not.

`docker compose up` itself is never run: it would grant `privileged` and host mounts before
anything could refuse them.
