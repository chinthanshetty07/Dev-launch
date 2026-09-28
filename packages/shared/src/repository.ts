/** What the analyzer extracts from a repository, and all the planner is allowed to see. */
export interface RepositoryMetadata {
  /** Absolute path of the clone on disk. */
  root: string;
  fileCount: number;
  sizeBytes: number;

  /** Present when the repository ships a Dockerfile. v1 never builds it — see limitations. */
  hasDockerfile: boolean;
  tsconfig: boolean;

  packageJson?: PackageJsonSummary;
  /** Lockfiles found at the chosen working directory, in discovery order. */
  lockfiles: string[];
  /** Framework configuration files found, e.g. vite.config.ts, next.config.mjs. */
  frameworkConfigs: string[];

  python?: PythonSummary;

  /** Variables declared in .env.example, with whether a default value was supplied. */
  envExample: EnvExampleVar[];
  readmeExcerpt?: string;

  /** Packages discovered when the repository is a monorepo. */
  workspace?: WorkspaceSummary;

  /**
   * Every directory in the repository that can be run as its own process.
   *
   * A repository is not one application. `frontend/` calling `backend/` is the ordinary
   * shape of a web project, and running only one of them produces a UI that loads and
   * then fails every request it makes — which looks like a broken tool rather than a
   * half-started application.
   */
  services?: ServiceCandidate[];

  /**
   * The one runnable part, when it is not at the repository root.
   *
   * A repository is not always a project *or* an application at its top level. The
   * commonest third shape is an application in `src/` or `backend/` with only
   * configuration above it — `build: ./src` in a compose file and nothing else. Planning
   * the root finds no manifest and declines, and a declining rule-based planner is
   * precisely what hands the repository to a model. The directory was declared all
   * along.
   */
  soleService?: ServiceCandidate;

  /** Infrastructure the repository expects to exist but does not contain. */
  backing?: BackingService[];

  /**
   * HTTP routes the application declares, read from its source.
   *
   * An API reaches READY and its root returns 404, because an API has no page at `/`.
   * Handing a person that URL and nothing else is handing them a blank "Cannot GET /" —
   * the application is running perfectly and looks broken. The routes are what there is
   * to open instead, and they were in the source all along.
   */
  httpRoutes?: HttpRoute[];
  /**
   * The port this application's own code opens, when it says so outright.
   *
   * A framework default is a prediction; `const port = 8017` beside `app.listen(port)`
   * is a fact, and it wins. An application that hardcodes a port ignores the `PORT`
   * DevLaunch injects, so planning on the default watches a port nothing will ever open
   * and reports a working application as failing to start.
   */
  declaredPort?: number;
  /**
   * Node built-in modules the source imports by their `node:` prefix.
   *
   * A repository's most reliable statement about the runtime it needs. `engines.node` is
   * a declaration many projects never make — the one that prompted this declares none —
   * while `import { DatabaseSync } from 'node:sqlite'` is made by necessity, and
   * `node:sqlite` did not exist before 22.5. Without it the run fails inside the module
   * loader with `ERR_UNKNOWN_BUILTIN_MODULE`, from a name indistinguishable from every
   * other built-in.
   */
  nodeBuiltins?: string[];
  /**
   * A loopback bind address written into the source as a literal.
   *
   * No environment variable, flag or plan can change `app.listen(port, 'localhost')`.
   * Knowing it in advance turns two doomed repair attempts into one honest failure that
   * names the line to edit.
   */
  hardcodedBind?: { file: string; line: string };
  /** Non-fatal problems, e.g. an unparseable package.json. */
  warnings: string[];
}

export interface HttpRoute {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'ALL';
  path: string;
  /** Where it was read from, relative to the service directory. */
  source: string;
}

export interface PackageJsonSummary {
  name?: string;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  /** Declared engines.node, when present. */
  engineNode?: string;
  /** Raw `workspaces` field, npm/yarn style. */
  workspaces?: string[];
  /** The manifest's `main`, when declared. */
  main?: string;
  /**
   * The manifest's `packageManager`, verbatim — e.g. `yarn@4.6.0`.
   *
   * An author saying which tool builds this project, and not advice: Yarn 1, which every
   * node image ships, reads this field, refuses to run, and prints a paragraph about
   * corepack. It also outranks a lockfile: a lockfile says which tool ran last, and this
   * says which one is meant to.
   */
  packageManager?: string;
  /**
   * Conventional entry files that exist beside the manifest — `app.js`, `server.js`,
   * `index.js` and their `src/` equivalents.
   *
   * A framework with no `start` or `dev` script is not unplannable; it is the commonest
   * shape of a tutorial repository, and `node app.js` is what its README says. Falling
   * to the AI for that was a model call to read a filename.
   */
  entryFiles?: string[];
}

export interface PythonSummary {
  requirements: string[];
  /**
   * Third-party distributions the entry files import, in import order.
   *
   * The last resort for a project that declares nothing. A lone `app.py` with no
   * requirements.txt is the commonest shape of a tutorial repository, and it used to be
   * declined outright and handed to the model — which read the imports and installed
   * them. `import flask_sqlalchemy` is a declaration, not a hint, so reading it needs no
   * model.
   */
  imports?: string[];
  /**
   * Distributions the source's imports prove it needs, which the manifest will not get.
   *
   * `imports` reduces every import to the name pip installs, which is right for
   * installing and throws away the only evidence that a *part* of a distribution was
   * asked for. `from sqlalchemy.ext.asyncio import create_async_engine` becomes
   * `sqlalchemy`, and `pip install sqlalchemy` installs no greenlet — so the application
   * starts, answers nothing, and dies on its first query.
   *
   * `because` is the module that implied it, so the warning can name its evidence.
   */
  impliedRequirements?: { requirement: string; because: string }[];
  /**
   * A database URL written into the source with a loopback host.
   *
   * It reads no environment variable, so there is nothing for DevLaunch to set — and
   * inside a container `localhost` is the application itself, so a provisioned database
   * sits unreachable beside it. The failure that follows is `connection to server at
   * "localhost" (::1), port 5432 failed: Connection refused`, which is accurate and
   * explains nothing.
   */
  hardcodedDatabaseUrl?: { file: string; url: string };
  /**
   * Dependency names from pyproject.toml, which requirements.txt-only reading missed.
   *
   * The framework signal was read from requirements.txt alone, so a packaged project —
   * `pip install .`, PEP 621 metadata — declaring fastapi was planned as nothing at all
   * and fell through to the AI, which guessed. Names only, lower-cased.
   */
  dependencies?: string[];
  /**
   * Only what the application needs to run — `[project] dependencies`, not its extras
   * or dev groups. Installing `pytest` into a runtime container is a slower build and a
   * wider surface for nothing.
   */
  runtimeDependencies?: string[];
  /**
   * Scripts at the working directory that create the database the application expects.
   *
   * A very common shape: `app.py` opens `todo.db` and a separate `db_create.py` creates
   * its tables, with the README listing it as an installation step. Skip it and the
   * application starts perfectly and answers 500 to every request —
   * `no such table: tasks` — which reads as a broken repository and is a missing step.
   *
   * Recognised by name, and only names that mean "create the schema". `setup.py` is a
   * packaging file and never belongs here; `seed.py` writes data rather than structure.
   */
  initScripts?: string[];
  hasPyproject: boolean;
  /**
   * Whether `pip install .` can actually build this project.
   *
   * A pyproject.toml does not mean a buildable package. Setuptools' flat-layout
   * discovery refuses outright when a project has several top-level directories and no
   * explicit package configuration — `Multiple top-level packages discovered in a
   * flat-layout: ['app', 'certs', 'resources']` — and that is an ordinary application
   * layout, not a mistake. The dependencies are still declared and still installable;
   * the project itself simply is not a distribution.
   */
  packageable?: boolean;
  hasPipfile: boolean;
  /** manage.py at the root is the definitive Django signal. */
  hasManagePy: boolean;
  /** Top-level modules that import a web framework, e.g. { file: 'app.py', framework: 'flask' }. */
  entryCandidates: PythonEntry[];
}

export interface PythonEntry {
  file: string;
  /**
   * The importable module path, when the file is inside a package rather than at the
   * working directory.
   *
   * `src/pg_rag/main.py` is not runnable as `uvicorn src/pg_rag/main:app`; once the
   * package is installed it is `pg_rag.main:app`, and that is the only form that works.
   * Absent for a top-level file, whose module is just its name.
   */
  module?: string;
  framework: 'flask' | 'django' | 'fastapi' | 'streamlit' | 'gradio' | null;
  /**
   * Whether the file is named like an entry point — `app.py`, `main.py`, `wsgi.py`.
   *
   * The scan reads every top-level `.py` file, because a Streamlit dashboard is called
   * `dashboard.py` and no list of names catches the next one. That breadth needs a
   * counterweight: when no file imports the framework, the fallback must not settle on
   * whatever came first. One repository's only top-level module is `tests.py`, and it was
   * started as `FLASK_APP=tests`.
   *
   * Only an explicit `false` disqualifies a candidate. Absent means "nobody said", and
   * the safe reading of that is to allow it: the bug being guarded against is a scan
   * that *added* junk, and that scan marks what it adds.
   */
  conventional?: boolean;
  /**
   * Directory the file lives in, relative to the working directory, when not at its root.
   *
   * A small Flask project keeps its application in `app/app.py` with no `__init__.py`,
   * and imports its siblings as `from routes.task_route import ...` — which only resolves
   * with `app/` as the working directory. The plan runs there and installs from the root,
   * where requirements.txt is.
   */
  dir?: string;
  /** Name of the module-level app object, when one is obvious. */
  appVariable?: string;
}

export interface EnvExampleVar {
  key: string;
  hasDefault: boolean;
}

export interface WorkspaceSummary {
  kind: 'npm' | 'pnpm';
  /** Packages that declare a dev or start script, i.e. plausible run targets. */
  runnable: WorkspacePackage[];
  /** Every workspace package found, runnable or not. */
  total: number;
}

export interface WorkspacePackage {
  name: string;
  /** Path relative to the repository root. */
  dir: string;
  scripts: string[];
}

/**
 * What a service is for, which decides how it is run and reached.
 *
 * `web` is served to a browser and is the session's entry point. `api` is called by a
 * `web` service, usually from the browser rather than container-to-container — which is
 * why its host port matters. `worker` listens on nothing.
 */
export type ServiceRole = 'web' | 'api' | 'worker';

export interface ServiceCandidate {
  /** Directory name, or the package name when one is declared. */
  name: string;
  /** Path relative to the repository root; '.' for a single-service repository. */
  dir: string;
  role: ServiceRole;
  language: 'node' | 'python';
  /** npm scripts available, for a Node service. */
  scripts: string[];
  /** What gave the role away, e.g. "depends on express". Shown, never acted on blindly. */
  evidence: string;
  /**
   * Port the service's own code defaults to, read from its source.
   *
   * Distinct from the port it will be *reached* on: a service that defaults to 5000 but
   * whose frontend calls 5001 has to be moved, and knowing both is what makes that
   * decidable rather than a guess.
   */
  declaredPort?: number;
  /**
   * Absolute origins a `web` service has hardcoded, e.g. `http://localhost:5001`.
   *
   * These are resolved by the *browser*, not by Docker's network, so a container alias
   * cannot satisfy them. The port an API is published on has to match, or every request
   * the page makes is refused.
   */
  callsOrigins?: string[];

  /**
   * Loopback origins an `api` service hardcodes — in practice, its CORS allowlist.
   *
   * The mirror image of `callsOrigins`, and the other half of the same failure. A page
   * can be served, an API can be published, every container can be healthy, and every
   * request still be refused — because `cors({ origin: 'http://localhost:5173' })` names
   * a port the frontend is no longer on. From the browser that is indistinguishable from
   * an API that is down, which is why a run like it reached READY and looked fine.
   *
   * Recorded with the file, because when nothing reads a variable the only remedy is to
   * name the line.
   */
  acceptsOrigins?: { origin: string; file: string }[];

  /**
   * A dev-server proxy pointing at an address its own container cannot reach.
   *
   * `proxy: { '/api': 'http://localhost:8000' }` is resolved by the dev server process,
   * which runs inside this service's container — so `localhost` is this service, and
   * every request the page makes returns 502 through a stack that is otherwise working.
   */
  devProxy?: { file: string; target: string };
  /**
   * Environment variables this service names for itself.
   *
   * Read from its own `.env.example` and its source. What a service *declares* is the
   * only reliable way to hand it a value: a frontend reading `VITE_API_URL` ignores
   * `REACT_APP_API_URL`, and a variable nobody reads is the same as no configuration.
   */
  envKeys?: string[];
  /**
   * Variables the service's own `.env.example` declares, and whether each ships a value.
   *
   * A repository's configuration lives beside the service that reads it — a backend's
   * API key is in `backend/.env.example`, not at the root — so a gate that only reads
   * the root asks for nothing and lets the container start without it.
   */
  envExample?: EnvExampleVar[];
}

/** A variable a session is waiting on, and the service that needs it. */
export interface RequiredEnvVar extends EnvExampleVar {
  /** Absent for a single-service session, which has only one thing to configure. */
  service?: string;
}

/** A database or cache the repository expects to be running. */
export interface BackingService {
  kind: 'mongodb' | 'postgres' | 'mysql' | 'redis';
  /** The dependency or variable that gave it away. */
  evidence: string;
  /** Environment variable the application reads its connection string from. */
  urlEnvKey?: string;
  /**
   * Every variable worth supplying the connection string as.
   *
   * One entry when the service declares which it reads. With nothing to go on, all the
   * known aliases for that kind: an unread variable costs nothing, and guessing a single
   * wrong name costs the entire run.
   */
  urlEnvKeys?: string[];
  /**
   * The database driver the repository actually declares, when it names one.
   *
   * SQLAlchemy encodes the driver in the URL scheme, so this is not decoration: a
   * project depending on `asyncpg` and handed `postgresql://` loads psycopg2 and dies
   * with "The asyncio extension requires an async driver to be used". The connection
   * string is correct, the server is running, and it still cannot start.
   */
  driver?: string;
  /**
   * The image the repository's own compose file names, when it names one.
   *
   * Not decoration: a project using pgvector needs `pgvector/pgvector`, and plain
   * `postgres` starts perfectly and then fails its first `CREATE EXTENSION vector`.
   * Honoured only if it is a known variant of this kind — see isBackingImageApproved.
   */
  image?: string;
  /** The database name the repository expects, when its compose file states one. */
  database?: string;
  /** Which services need it. */
  neededBy: string[];
}
