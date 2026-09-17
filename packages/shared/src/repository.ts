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
