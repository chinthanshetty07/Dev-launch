import { FailureCode, type FailureDetail } from '@devlaunch/shared';

export type Phase = 'none' | 'install' | 'build' | 'start';

export interface Signature {
  id: string;
  code: FailureCode;
  /** Phases this signature can apply to. Empty means any. */
  phases?: Phase[];
  patterns: RegExp[];
  /**
   * Lines that are never evidence for this signature, whatever they contain.
   *
   * A package manager warns about exactly the things it fails on, in nearly the same
   * words: `npm warn EBADENGINE Unsupported engine` and `npm error code EBADENGINE` differ
   * only in severity, and one of them is fatal.
   */
  exclude?: RegExp;
  /**
   * A line that must also appear somewhere in the log for this signature to apply.
   *
   * For a failure only told apart by a *second* line: Node names a missing entry file
   * and a missing `require` in the same words, and only `requireStack: []` underneath
   * says nothing required it.
   */
  alsoNeeds?: RegExp;
  /** Typed facts the verdict carries, for a repair rule to act on without reading prose. */
  detail?: Pick<FailureDetail, 'runtimeDirection'>;
  /** What the user can do about it. */
  remedy: string;
  /** Explains the match; `{evidence}` is replaced with the matching line. */
  describe: (evidence: string) => string;
}

/**
 * Ordered failure signatures, most specific first.
 *
 * Order matters as much as it does in the planner: "ECONNREFUSED 127.0.0.1:5432" is a
 * missing database, not a generic network failure, and a broad network rule placed
 * first would swallow it and send the user after the wrong problem entirely.
 */
export const SIGNATURES: readonly Signature[] = Object.freeze([
  // --- resource exhaustion ---------------------------------------------------
  {
    id: 'oom-killed',
    code: FailureCode.OUT_OF_MEMORY,
    patterns: [
      /JavaScript heap out of memory/i,
      /FATAL ERROR:.*Allocation failed/i,
      /\bKilled\b\s*$/m,
      /MemoryError/,
      /Out of memory: Killed process/i,
      /signal SIGKILL \(Forced quit\)/i,
    ],
    remedy:
      'Raise DEVLAUNCH_CONTAINER_MEMORY_MB, or give the Colima VM more memory with ' +
      '`colima stop && colima start --cpu 4 --memory 6`.',
    describe: () => 'The process was killed for exceeding the container memory limit.',
  },
  {
    id: 'docker-socket-required',
    code: FailureCode.DOCKER_SOCKET_REQUIRED,
    patterns: [
      /No Docker socket found/i,
      /Cannot connect to the Docker daemon/i,
      /(connect )?ENOENT.*docker\.sock/i,
      /docker\.sock.*(no such file|not found|permission denied)/i,
      /Is the docker daemon running/i,
    ],
    remedy:
      'DevLaunch never mounts the Docker socket into a container — its absence is what ' +
      'stops a repository escaping the sandbox — so a project that drives Docker itself ' +
      'cannot run inside one. Run this project directly on your machine.',
    describe: () =>
      'The project needs to talk to the Docker daemon, which is deliberately not ' +
      'reachable from inside the sandbox.',
  },
  {
    id: 'workspace-protocol-unsupported',
    code: FailureCode.DEPENDENCY_INSTALL_FAILED,
    patterns: [
      /EUNSUPPORTEDPROTOCOL/,
      /Unsupported URL Type "workspace:"/i,
      /workspace:\*/,
    ],
    remedy:
      'The repository is a workspace whose packages reference each other as ' +
      '`workspace:*`. It has to be installed once at its root by the tool that wrote ' +
      'its lockfile — pnpm or yarn — rather than one package at a time.',
    describe: () =>
      'A package was installed on its own, but it depends on a sibling through the ' +
      'workspace protocol, which only a workspace-aware install can resolve.',
  },
  {
    id: 'disk-full',
    code: FailureCode.DEPENDENCY_INSTALL_FAILED,
    patterns: [/ENOSPC/, /No space left on device/i],
    // The remedy used to name the VM's disk, which is usually the wrong place to look:
    // /tmp is a 64 MB tmpfs and it is what an install fills, while the volume beside it
    // has tens of gigabytes free. Both are worth saying, most likely cause first.
    remedy:
      'Almost always the container\'s 64 MB /tmp rather than a full disk — build scratch ' +
      'belongs on the workspace volume, which TMPDIR points at. Raise it with ' +
      'DEVLAUNCH_CONTAINER_TMP_MB if a tool ignores TMPDIR, or reclaim space in the ' +
      'Colima VM with `docker builder prune` if the VM really is full.',
    describe: () => 'The container ran out of disk space.',
  },

  // --- architecture ----------------------------------------------------------
  {
    id: 'arch-incompatible',
    code: FailureCode.ARCH_INCOMPATIBLE,
    patterns: [
      /Exec format error/i,
      /cannot execute binary file/i,
      /wrong ELF class/i,
      /EBADPLATFORM/,
      /unsupported platform/i,
      /no prebuilt binaries? (?:are )?available/i,
      /not compatible with your (?:platform|architecture)/i,
    ],
    remedy:
      'The dependency ships no arm64 build. Try a version that does, or run DevLaunch ' +
      'on an x86 host — v1 does not emulate.',
    describe: () => 'A dependency provides no build for this machine\'s architecture (arm64).',
  },

  // --- external services: must precede the generic network rule ---------------
  {
    id: 'database-required',
    code: FailureCode.DATABASE_REQUIRED,
    patterns: [
      /ECONNREFUSED\s+\S*:(?:5432|3306|27017|6379|1433)\b/,
      /could not connect to server.*(?:postgres|5432)/i,
      /OperationalError.*could not translate host name/i,
      /getaddrinfo\s+(?:ENOTFOUND|EAI_AGAIN)\s+(?:db|database|postgres\w*|mysql|mariadb|redis|mongo\w*)\b/i,
      /MongoNetworkError/,
      /Connection refused.*(?:redis|Redis)/,
      /django\.db\.utils\.OperationalError/,
      /password authentication failed for user/i,
    ],
    remedy:
      'This project needs an external database. V1 does not provision one — see ' +
      'docs/limitations.md.',
    describe: () => 'The application could not reach a database or cache it depends on.',
  },

  // --- environment -----------------------------------------------------------
  {
    id: 'missing-env',
    code: FailureCode.MISSING_ENV,
    patterns: [
      /ImproperlyConfigured:.*SECRET_KEY/i,
      /The SECRET_KEY setting must not be empty/i,
      /(?:Missing|Required|Undefined) (?:required )?environment variable/i,
      /environment variable\s+["'`]?([A-Z][A-Z0-9_]{2,})["'`]?\s+(?:is )?(?:not set|missing|required)/i,
      /KeyError:\s*['"]([A-Z][A-Z0-9_]{2,})['"]/,
      /pydantic_settings.*validation error/i,
      /Error:\s*([A-Z][A-Z0-9_]{2,})\s+(?:is required|must be (?:set|defined))/,
      // The other word order: "set the `OPENAI_API_KEY` environment variable". The
      // OpenAI SDK says it this way at import time, and it was landing as a
      // low-confidence generic start failure with the variable's name in plain sight.
      /set (?:the )?["'`]?([A-Z][A-Z0-9_]{2,})["'`]?(?: or ["'`]?[A-Z][A-Z0-9_]{2,}["'`]?)* environment variable/i,
      /Missing credentials\./i,
    ],
    remedy:
      'Supply the variable before launching. DevLaunch reads .env.example and prompts ' +
      'for anything without a default.',
    describe: (e) => `A required environment variable is not set: ${e.trim().slice(0, 160)}`,
  },

  // --- runtime version -------------------------------------------------------
  {
    // Thrown by the module loader, not by a dependency: the name looks like every other
    // built-in and the failure surfaces as "nothing is listening", because a watcher
    // keeps the container alive after the crash. One real repository imports
    // `node:sqlite`, which arrived in 22.5, declares no `engines` field at all, and was
    // reported as a port problem while a model rewrote its start command.
    id: 'unknown-builtin-module',
    code: FailureCode.WRONG_RUNTIME_VERSION,
    patterns: [
      /ERR_UNKNOWN_BUILTIN_MODULE/,
      /No such built-in module: node:([a-z_]+)/,
    ],
    remedy:
      'The application imports a Node built-in module that the running version does not ' +
      'have. DevLaunch picks the version from the repository — an `engines.node` range, ' +
      'or a `node:` import it recognises — so a built-in newer than any approved image ' +
      'is the one case it cannot satisfy.',
    describe: (e) => `This Node version has no such built-in module: ${e.trim().slice(0, 160)}`,
  },
  {
    // ts-node type-checks before it runs anything, and refuses on a type error:
    // `TSError: ⨯ Unable to compile TypeScript:` followed by tsc's own diagnostic lines.
    // Under nodemon the process then waits for a file change, so the container stays up
    // with nothing listening — and the run was reported as `PORT_NOT_LISTENING`,
    // uncertain, quoting a line from the middle of the error. Seen on
    // `niksbanna/mern-boilerplate`: no lockfile, so a newer @types/jsonwebtoken than the
    // author had, and `src/utils/jwt.ts(6,14): error TS2769`.
    id: 'typescript-compile-error',
    code: FailureCode.START_COMMAND_FAILED,
    phases: ['start'],
    patterns: [/\.[cm]?tsx?\(\d+,\d+\): error TS\d+:/],
    remedy:
      'The code does not pass its own type check, so ts-node refuses to run it. Code that ' +
      'type-checked for its author often does not with newer type definitions — a ' +
      'repository with no lockfile gets the newest. DevLaunch retries once with type ' +
      'checking off (TS_NODE_TRANSPILE_ONLY=true), which runs the same code; the type ' +
      'error itself is the repository\'s to fix.',
    describe: (evidence) => `The TypeScript code does not compile: ${evidence.trim()}`,
  },
  {
    // webpack 4 hashes with md4, which OpenSSL 3 — Node 17 and later — no longer offers:
    // `error:0308010C:digital envelope routines::unsupported`. It reads like a crash in
    // the application and went to a model, whose one idea, NODE_OPTIONS, the validator
    // refuses by design. What it actually says is that the runtime is too new, and no
    // image DevLaunch has is old enough.
    id: 'openssl-legacy-hash',
    code: FailureCode.WRONG_RUNTIME_VERSION,
    // The error code alone: Node prints it with every one of these, and a second pattern
    // for the message beside it matched nothing the code did not.
    patterns: [/ERR_OSSL_EVP_UNSUPPORTED/],
    detail: { runtimeDirection: 'older' },
    remedy:
      'The build tool hashes with an algorithm OpenSSL 3 removed — typically webpack 4, as ' +
      'in react-scripts 4 and earlier. Upgrade it (react-scripts 5, webpack 5), or run the ' +
      'project on Node 16. DevLaunch approves Node 20 and 22 only, and will not set the ' +
      'usual workaround, NODE_OPTIONS=--openssl-legacy-provider: a variable that changes ' +
      'what Node loads before the start command runs is refused from every plan.',
    describe: () =>
      'The build tool uses a hash OpenSSL 3 no longer provides, so it cannot run on Node 17 ' +
      'or newer — and DevLaunch has no older Node.',
  },
  {
    id: 'wrong-runtime-version',
    code: FailureCode.WRONG_RUNTIME_VERSION,
    // A warning is not the failure. npm prints `npm warn EBADENGINE` for every transitive
    // package whose `engines` field the running Node misses and installs it regardless;
    // a run that then died on something else entirely was reported as this, and a repair
    // spent moving it to another Node that failed the same way.
    exclude: /^\s*(?:npm\s+)?(?:warn|WARN|warning)\b|\s WARN\s/,
    patterns: [
      /EBADENGINE/,
      // pnpm's fatal form, under `engine-strict=true`. It was a generic install failure,
      // and the deterministic move to Node 22 that answers it never fired.
      /ERR_PNPM_UNSUPPORTED_ENGINE/,
      /engine\s+["']?node["']?\s+is incompatible/i,
      /requires Node(?:\.js)? version/i,
      /Unsupported engine/i,
      /requires Python\s*[><=]/i,
      /This package requires Node/i,
    ],
    remedy:
      'The repository asks for a runtime version DevLaunch does not provide. Node 20, ' +
      'Node 22 and Python 3.12 are available.',
    describe: () => 'The project requires a runtime version that is not available.',
  },

  // --- dependency resolution -------------------------------------------------
  {
    id: 'peer-dependency-conflict',
    code: FailureCode.DEPENDENCY_INSTALL_FAILED,
    phases: ['install'],
    patterns: [/ERESOLVE (?:unable to resolve|could not resolve)/i, /peer dep(?:endency)? missing/i],
    remedy: 'The repository has conflicting peer dependencies; it may need --legacy-peer-deps.',
    describe: () => 'npm could not resolve a consistent dependency tree.',
  },
  {
    // A pyproject.toml is not a promise of a buildable package. This is an ordinary
    // application layout — code beside its certificates and assets — and setuptools
    // refuses to guess which directory is the distribution. Nothing is wrong with the
    // repository; `pip install .` was simply the wrong way to install it.
    id: 'flat-layout-not-a-package',
    code: FailureCode.DEPENDENCY_INSTALL_FAILED,
    phases: ['install'],
    patterns: [
      /Multiple top-level packages discovered in a flat-layout/i,
      /Multiple top-level modules discovered in a flat-layout/i,
    ],
    remedy:
      'This project is an application, not a distribution: its dependencies are ' +
      'declared in pyproject.toml but it cannot be built as a package. DevLaunch ' +
      'installs the declared dependencies by name instead.',
    describe: (e) => `The project cannot be installed as a package: ${e.trim().slice(0, 160)}`,
  },
  {
    // Before the generic native-build rule, because the error names its own remedy: the
    // source distribution needs Postgres' development headers, and the project publishes
    // a prebuilt wheel under a different name for exactly this case.
    id: 'psycopg2-needs-pg-config',
    code: FailureCode.DEPENDENCY_INSTALL_FAILED,
    phases: ['install', 'build'],
    patterns: [/pg_config executable not found/i, /pg_config is required to build psycopg2/i],
    remedy:
      '`psycopg2` builds from source and needs the PostgreSQL client headers, which the ' +
      'runner image does not carry. Its own maintainers publish `psycopg2-binary` as a ' +
      'prebuilt wheel for this; DevLaunch substitutes it.',
    describe: () => 'psycopg2 cannot be built from source: pg_config is not on PATH.',
  },
  {
    // A dependency whose build script predates the Python it is being built on. Pip
    // reaches for a source distribution only when no wheel matches the interpreter, so
    // this is what an old pin looks like on 3.12: the sdist's own setup.py fails.
    //
    // There is no repair. `--only-binary` cannot help — pip would have taken a wheel if
    // one existed — and no rewritten install command changes which interpreter is
    // present. Saying so costs one classification instead of a model call and a second
    // full reinstall.
    id: 'sdist-build-unsupported-on-python',
    code: FailureCode.WRONG_RUNTIME_VERSION,
    phases: ['install', 'build'],
    patterns: [
      /ModuleNotFoundError: No module named 'pkg_resources'/,
      /'build_ext' object has no attribute 'cython_sources'/,
      /Cannot import 'setuptools\.build_meta'/,
    ],
    remedy:
      'A pinned dependency has no wheel for Python 3.12, and its source build does not ' +
      'work there either. DevLaunch provides only Python 3.12. Loosen that pin to a ' +
      'version that publishes a 3.12 wheel, or run this project on the Python it was ' +
      'written for.',
    describe: (e) =>
      `A dependency could not be built for Python 3.12: ${e.trim().slice(0, 160)}`,
  },
  {
    // A dependency written for a Python that still had these modules. Not a repository
    // problem, not a plan problem, and nothing a different install command reaches.
    id: 'removed-stdlib-module',
    code: FailureCode.WRONG_RUNTIME_VERSION,
    patterns: [
      /ModuleNotFoundError: No module named '(?:imp|distutils|asynchat|asyncore|smtpd|cgi|cgitb)'/,
    ],
    remedy:
      'A dependency imports a module the standard library removed in Python 3.12, which ' +
      'is the only Python DevLaunch provides. Upgrade that dependency to a version that ' +
      'supports 3.12, or run this project on an older Python.',
    describe: (e) =>
      `A dependency uses a standard-library module removed in Python 3.12: ${e.trim().slice(0, 160)}`,
  },
  {
    // Before the generic native-build rule, because it names the cause exactly: the
    // module's own Makefile called a bare `python` and the image had only `python3`.
    // node-gyp's toolchain check passed moments earlier, so the generic remedy —
    // "usually a missing system library" — sent people looking for the wrong thing.
    id: 'python-alias-missing',
    code: FailureCode.DEPENDENCY_INSTALL_FAILED,
    phases: ['install', 'build'],
    patterns: [/\/bin\/sh: \d*:? ?python: not found/, /(?:^|\s)python: not found/],
    remedy:
      'A native module\'s build script runs `python` unqualified. The runner image now ' +
      'ships python-is-python3; rebuild it (docker/runner/node.Dockerfile).',
    describe: () => 'A native module\'s build script needs `python` on PATH, and only `python3` was present.',
  },
  {
    id: 'native-build-failed',
    code: FailureCode.DEPENDENCY_INSTALL_FAILED,
    phases: ['install', 'build'],
    patterns: [/gyp ERR!/, /node-gyp.*failed/i, /error: command '.*(?:gcc|cc|clang)' failed/i],
    remedy:
      'A native module failed to compile. The runner image ships build-essential, so ' +
      'this usually means a missing system library.',
    describe: () => 'A dependency with native code failed to build from source.',
  },
  {
    id: 'package-not-found',
    code: FailureCode.DEPENDENCY_INSTALL_FAILED,
    phases: ['install'],
    patterns: [
      /404 Not Found.*npm/i,
      /No matching distribution found for/i,
      /Could not find a version that satisfies the requirement/i,
    ],
    remedy: 'A declared dependency does not exist at the requested version.',
    describe: (e) => `A dependency could not be found: ${e.trim().slice(0, 160)}`,
  },

  // --- network: last of the connectivity rules -------------------------------
  {
    // A manifest npm, yarn or pnpm cannot parse, met at run time (a service's own
    // package.json): fixed in the repository, never by a different plan.
    id: 'invalid-manifest',
    code: FailureCode.INVALID_MANIFEST,
    patterns: [/npm (?:ERR!|error) code EJSONPARSE/, /ERR_PNPM_JSON_PARSE/, /Invalid package\.json/i, /JSON\.parse Invalid package\.json/],
    remedy: 'Fix the package.json at the position the parser names; no package manager can read it as it is.',
    describe: () => 'A package.json in the repository is not valid JSON, so nothing could be installed from it.',
  },
  {
    // A dependency fetched from a host that does not exist. Not the network: DNS answered,
    // and the answer is that the name has no address. Only a well-known registry failing
    // to resolve says the network is the problem (the next signature).
    id: 'dependency-host-unknown',
    code: FailureCode.DEPENDENCY_INSTALL_FAILED,
    phases: ['install'],
    patterns: [/getaddrinfo ENOTFOUND (?!registry\.npmjs\.org|registry\.yarnpkg\.com|registry\.npmmirror\.com|pypi\.org|files\.pythonhosted\.org|github\.com|codeload\.github\.com|objects\.githubusercontent\.com)[a-z0-9.-]+/i],
    remedy: 'A dependency in the manifest points at a host that does not exist. Correct its URL, or depend on the published package instead.',
    describe: (e) => {
      const host = /ENOTFOUND ([a-z0-9.-]+)/i.exec(e)?.[1] ?? 'its host';
      return `A dependency is fetched from ${host}, which has no address: the name does not exist, so the install cannot succeed from this manifest.`;
    },
  },
  {
    id: 'network-failure',
    code: FailureCode.NETWORK_FAILURE,
    patterns: [
      /getaddrinfo\s+EAI_AGAIN/,
      // A registry everyone depends on not resolving is this machine's network.
      /getaddrinfo ENOTFOUND (?:registry\.npmjs\.org|registry\.yarnpkg\.com|pypi\.org|files\.pythonhosted\.org|github\.com|codeload\.github\.com)/i,
      /Temporary failure in name resolution/i,
      /Could not resolve host/i,
      /ETIMEDOUT.*registry\./i,
      /network timeout at:/i,
      /SSL:\s*CERTIFICATE_VERIFY_FAILED/,
      /ECONNRESET.*registry\./i,
      // A registry's TLS handshake failing is a property of the network and the image's
      // certificate store, not of the repository. It was classified as a dependency
      // install failure and repaired — twice, each attempt re-running the same download
      // against the same certificate.
      /certificate has expired/i,
      /unable to (?:get|verify) local issuer certificate/i,
      /self[- ]signed certificate in certificate chain/i,
      /There appears to be trouble with your network connection/i,
    ],
    remedy:
      'The container could not reach a package registry. Check connectivity, and that ' +
      'the egress policy has not blocked more than intended. A certificate error here ' +
      'is usually the runner image\'s CA bundle being older than the registry\'s ' +
      'certificate — rebuild it (scripts/build-runner-images.sh).',
    describe: () => 'A network operation failed while reaching an external service.',
  },

  // --- application startup ---------------------------------------------------
  // Before `module-not-found`, and the ordering is the whole point: a relative
  // specifier and a bare one produce the same sentence and have opposite answers.
  {
    id: 'relative-module-not-found',
    code: FailureCode.BROKEN_IMPORT,
    phases: ['start', 'build'],
    patterns: [
      // Only a *relative* specifier, and the distinction is load-bearing rather than
      // cosmetic. Node reports a `require` exactly as it was written — `'./routes/users'`
      // — and resolves a command-line entry to an absolute path first, so
      // `node wrong-entry.js` fails with `'/workspace/wrong-entry.js'`.
      //
      // Which is the difference between the two failures. A relative specifier is the
      // repository's own source importing a sibling that is not there, and no plan
      // reaches it. An absolute one is usually the *plan* naming the wrong entry file,
      // which is precisely what repair exists to correct — and treating it as
      // unrepairable took away the fix for the commonest thing repair is good at.
      /Cannot find module\s+['"]\.{1,2}\/[^'"]*['"]/,
      /Error \[ERR_MODULE_NOT_FOUND\][^\n]*['"](?:file:)?\.{1,2}\/[^'"]*['"]/,
      /ImportError: attempted relative import/,
    ],
    remedy:
      'This is a path inside the repository, relative to the file importing it, so no ' +
      'install or plan change reaches it. The file is named differently, is in another ' +
      'directory, or was never committed — check the spelling and the case, which ' +
      'matters here even where it does not on macOS.',
    describe: (e) =>
      `The repository imports one of its own files by a path that is not there: ${e.trim().slice(0, 160)}`,
  },
  {
    // Before `module-not-found`, which matches the same line. Node resolves a
    // command-line entry to an absolute path and reports that nothing required it; the
    // file the start command runs is simply not there. Calling that a missing dependency
    // (`techiescamp/kubernetes-ai-projects`, `node index.js` in a repository with no
    // index.js) sent the reader after an install problem that did not exist.
    id: 'entry-file-not-found',
    code: FailureCode.START_COMMAND_FAILED,
    phases: ['start'],
    patterns: [/Cannot find module\s+['"]\/[^'"]+['"]/],
    alsoNeeds: /^\s*requireStack: \[\]/,
    remedy:
      'The start command names the wrong file. Check which file the project is really ' +
      'started from (its package.json "main" or "start" script, or its README).',
    describe: (e) => {
      const path = /['"]([^'"]+)['"]/.exec(e)?.[1] ?? '';
      const shown = path.replace(/^\/workspace\//, '');
      return `The start command runs \`${shown}\`, and there is no such file.`;
    },
  },
  {
    id: 'module-not-found',
    code: FailureCode.START_COMMAND_FAILED,
    phases: ['start', 'build'],
    patterns: [
      /Cannot find module\s+['"]([^'"]+)['"]/,
      /ERR_MODULE_NOT_FOUND/,
      /ModuleNotFoundError: No module named/,
      /ImportError: cannot import name/,
    ],
    remedy:
      'The entry point imports something that was not installed. The install step may ' +
      'have been skipped, or the dependency is missing from the manifest.',
    describe: (e) => `A module the application imports is missing: ${e.trim().slice(0, 160)}`,
  },
  {
    id: 'port-in-use',
    code: FailureCode.PORT_NOT_LISTENING,
    phases: ['start'],
    patterns: [/EADDRINUSE/, /Address already in use/i],
    remedy: 'Something inside the container already holds that port.',
    describe: () => 'The application could not bind its port because it was already in use.',
  },
  {
    // `node --env-file=.env` exits at once when the file is not there, printing
    // `node: .env: not found`. A repository commits `.env.example` and a README telling a
    // person to copy it; a clone has neither the copy nor the person. Read by the generic
    // rule below it was "the start command could not be run", which sent a repair after
    // a command that exists.
    id: 'env-file-missing',
    code: FailureCode.MISSING_ENV,
    phases: ['start'],
    patterns: [/^node: (\S+): not found\s*$/],
    remedy:
      'The start script loads a dotenv file with Node\'s --env-file, and the repository ' +
      'does not contain it — usually it is meant to be copied from .env.example. Create ' +
      'it in the repository, or change the script to --env-file-if-exists (Node 22+). ' +
      'DevLaunch passes configuration as environment variables, which a missing file ' +
      'stops Node from ever reading.',
    describe: (e) =>
      `The start script loads ${/^node: (\S+):/.exec(e.trim())?.[1] ?? 'a dotenv file'} with --env-file, and the repository has no such file.`,
  },
  {
    id: 'command-not-found',
    code: FailureCode.START_COMMAND_FAILED,
    patterns: [
      /(?:command not found|not found)\s*$/m,
      /: No such file or directory\s*$/m,
      /Missing script:/i,
    ],
    remedy:
      'The start command does not exist in the container. For Python, console scripts ' +
      'live in $HOME/.local/bin when installed non-root.',
    describe: (e) => `The start command could not be run: ${e.trim().slice(0, 160)}`,
  },
]);
