import { FailureCode } from '@devlaunch/shared';

export type Phase = 'none' | 'install' | 'build' | 'start';

export interface Signature {
  id: string;
  code: FailureCode;
  /** Phases this signature can apply to. Empty means any. */
  phases?: Phase[];
  patterns: RegExp[];
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
    remedy: 'Reclaim space in the Colima VM with `docker builder prune`.',
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
    ],
    remedy:
      'Supply the variable before launching. DevLaunch reads .env.example and prompts ' +
      'for anything without a default.',
    describe: (e) => `A required environment variable is not set: ${e.trim().slice(0, 160)}`,
  },

  // --- runtime version -------------------------------------------------------
  {
    id: 'wrong-runtime-version',
    code: FailureCode.WRONG_RUNTIME_VERSION,
    patterns: [
      /EBADENGINE/,
      /engine\s+["']?node["']?\s+is incompatible/i,
      /requires Node(?:\.js)? version/i,
      /Unsupported engine/i,
      /requires Python\s*[><=]/i,
      /This package requires Node/i,
    ],
    remedy:
      'The repository asks for a runtime version DevLaunch does not provide. Only ' +
      'Node 20 and Python 3.12 are available.',
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
    id: 'network-failure',
    code: FailureCode.NETWORK_FAILURE,
    patterns: [
      /getaddrinfo\s+EAI_AGAIN/,
      /Temporary failure in name resolution/i,
      /Could not resolve host/i,
      /ETIMEDOUT.*registry\./i,
      /network timeout at:/i,
      /SSL:\s*CERTIFICATE_VERIFY_FAILED/,
      /ECONNRESET.*registry\./i,
    ],
    remedy:
      'The container could not reach a package registry. Check connectivity, and that ' +
      'the egress policy has not blocked more than intended.',
    describe: () => 'A network operation failed while reaching an external service.',
  },

  // --- application startup ---------------------------------------------------
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
