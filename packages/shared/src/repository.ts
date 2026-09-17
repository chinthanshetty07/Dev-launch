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

  /** Infrastructure the repository expects to exist but does not contain. */
  backing?: BackingService[];

  /** Non-fatal problems, e.g. an unparseable package.json. */
  warnings: string[];
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
}

export interface PythonSummary {
  requirements: string[];
  hasPyproject: boolean;
  hasPipfile: boolean;
  /** manage.py at the root is the definitive Django signal. */
  hasManagePy: boolean;
  /** Top-level modules that import a web framework, e.g. { file: 'app.py', framework: 'flask' }. */
  entryCandidates: PythonEntry[];
}

export interface PythonEntry {
  file: string;
  framework: 'flask' | 'django' | 'fastapi' | null;
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
  /** Which services need it. */
  neededBy: string[];
}
