/**
 * What a Python file imports that pip would have to fetch.
 *
 * The last resort for a repository that declares nothing. A single `app.py` with no
 * requirements.txt is the commonest shape of a tutorial project on GitHub, and the
 * rule-based planner declined every one of them — "No requirements.txt or pyproject.toml
 * found" — which sent them to the model. The model then read the imports and installed
 * them, which is not a judgement call: `import flask_sqlalchemy` is a declaration that
 * the distribution is required, and reading a declaration is not a model's job.
 *
 * Two things keep it honest. The standard library is excluded by name, so nothing tries
 * to `pip install json`. And a package is installed under the name it is imported by
 * unless it is one of the handful where those genuinely differ, which are listed rather
 * than guessed at.
 */

/**
 * Top-level standard library modules, Python 3.12.
 *
 * Long, and deliberately so: every name missing from here becomes a `pip install` of
 * something that does not exist, which fails the whole install.
 */
const STDLIB = new Set([
  'abc', 'argparse', 'array', 'ast', 'asyncio', 'atexit', 'base64', 'bdb', 'binascii',
  'bisect', 'builtins', 'bz2', 'calendar', 'cmath', 'cmd', 'code', 'codecs', 'codeop',
  'collections', 'colorsys', 'compileall', 'concurrent', 'configparser', 'contextlib',
  'contextvars', 'copy', 'copyreg', 'csv', 'ctypes', 'curses', 'dataclasses', 'datetime',
  'dbm', 'decimal', 'difflib', 'dis', 'doctest', 'email', 'encodings', 'enum', 'errno',
  'faulthandler', 'fcntl', 'filecmp', 'fileinput', 'fnmatch', 'fractions', 'ftplib',
  'functools', 'gc', 'getopt', 'getpass', 'gettext', 'glob', 'graphlib', 'grp', 'gzip',
  'hashlib', 'heapq', 'hmac', 'html', 'http', 'imaplib', 'importlib', 'inspect', 'io',
  'ipaddress', 'itertools', 'json', 'keyword', 'linecache', 'locale', 'logging', 'lzma',
  'mailbox', 'marshal', 'math', 'mimetypes', 'mmap', 'multiprocessing', 'netrc',
  'numbers', 'operator', 'optparse', 'os', 'pathlib', 'pdb', 'pickle', 'pickletools',
  'pkgutil', 'platform', 'plistlib', 'poplib', 'posixpath', 'pprint', 'profile', 'pty',
  'pwd', 'py_compile', 'pyclbr', 'pydoc', 'queue', 'quopri', 'random', 're', 'readline',
  'reprlib', 'resource', 'rlcompleter', 'runpy', 'sched', 'secrets', 'select',
  'selectors', 'shelve', 'shlex', 'shutil', 'signal', 'site', 'smtplib', 'socket',
  'socketserver', 'sqlite3', 'ssl', 'stat', 'statistics', 'string', 'stringprep',
  'struct', 'subprocess', 'symtable', 'sys', 'sysconfig', 'syslog', 'tabnanny',
  'tarfile', 'tempfile', 'termios', 'textwrap', 'threading', 'time', 'timeit', 'tkinter',
  'token', 'tokenize', 'tomllib', 'trace', 'traceback', 'tracemalloc', 'tty', 'types',
  'typing', 'unicodedata', 'unittest', 'urllib', 'uuid', 'venv', 'warnings', 'wave',
  'weakref', 'webbrowser', 'wsgiref', 'xml', 'xmlrpc', 'zipapp', 'zipfile', 'zipimport',
  'zlib', 'zoneinfo',
  // Not stdlib, but never installed: pip ships with the interpreter and setuptools is
  // a build dependency rather than something an application declares.
  'pip', 'setuptools', 'pkg_resources', '__future__',
  // Removed from the standard library, most of them in 3.12. They are listed here for
  // the opposite reason to the rest: they are exactly the names that turn up in
  // `ModuleNotFoundError`, and `pip install imp` does not exist. Some have third-party
  // backports, and installing one silently would be a guess — a dependency written
  // against a Python that still had these is a runtime-version problem, which is what
  // the `removed-stdlib-module` signature says it is.
  'imp', 'distutils', 'asynchat', 'asyncore', 'smtpd', 'cgi', 'cgitb', 'telnetlib',
  'nntplib', 'imghdr', 'sndhdr', 'chunk', 'crypt', 'mailcap', 'msilib', 'nis',
  'ossaudiodev', 'pipes', 'spwd', 'sunau', 'uu', 'xdrlib', 'audioop', 'aifc',
]);

/**
 * Distributions whose import name is not their package name.
 *
 * Short on purpose. PyPI resolves `flask_sqlalchemy` to `Flask-SQLAlchemy` on its own,
 * so only the cases where the two names genuinely differ belong here.
 */
const DISTRIBUTION_FOR: Readonly<Record<string, string>> = Object.freeze({
  cv2: 'opencv-python',
  yaml: 'pyyaml',
  dotenv: 'python-dotenv',
  jose: 'python-jose',
  jwt: 'pyjwt',
  bs4: 'beautifulsoup4',
  PIL: 'pillow',
  sklearn: 'scikit-learn',
  skimage: 'scikit-image',
  psycopg2: 'psycopg2-binary',
  MySQLdb: 'mysqlclient',
  serial: 'pyserial',
  OpenSSL: 'pyopenssl',
  dateutil: 'python-dateutil',
  attr: 'attrs',
  google: 'google-api-python-client',
  telegram: 'python-telegram-bot',
  multipart: 'python-multipart',
  jwt_extended: 'flask-jwt-extended',
  socketio: 'python-socketio',
  magic: 'python-magic',
  Crypto: 'pycryptodome',
  docx: 'python-docx',
  fitz: 'pymupdf',
});

/**
 * The distribution that provides an importable module, when the two differ.
 *
 * Exported so repair can translate `No module named 'cv2'` into something pip can
 * actually fetch. Returns the module name itself where PyPI's name matches, and nothing
 * at all for the standard library — `pip install imp` does not exist, and proposing it
 * would turn one honest failure into two.
 */
export function distributionForModule(module: string): string | null {
  if (STDLIB.has(module)) return null;
  return DISTRIBUTION_FOR[module] ?? module;
}

/**
 * Third-party distributions a source file declares it needs, in import order.
 *
 * Relative imports are skipped — `from .models import Note` is the repository's own
 * code — and so is anything the repository itself provides, which the caller supplies
 * as `local`.
 */
export function importedDistributions(source: string, local: readonly string[] = []): string[] {
  const own = new Set(local);
  const out: string[] = [];

  forEachImportedModule(source, (module) => {
    const top = module.split('.')[0]!;
    if (!top || STDLIB.has(top) || own.has(top)) return;
    // A conditional or lazily-imported name is still a name pip must fetch, but one
    // that is not a valid distribution name never is.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(top)) return;
    const dist = DISTRIBUTION_FOR[top] ?? top;
    if (!out.includes(dist)) out.push(dist);
  });

  return out;
}

/**
 * Distributions a source file's imports prove it needs, which its manifest will not get.
 *
 * `importedDistributions` reduces every import to its top-level name, because that is
 * what pip installs — and in doing so it throws away the only evidence that a *part* of
 * a distribution was asked for. `from sqlalchemy.ext.asyncio import create_async_engine`
 * becomes `sqlalchemy`, and `pip install sqlalchemy` installs no greenlet, so the
 * application starts, serves, and dies on its first query with "the SQLAlchemy asyncio
 * module requires that the Python 'greenlet' library is installed".
 *
 * Measured rather than assumed, in the runner image: `pip install sqlalchemy asyncpg`
 * leaves no greenlet, and `pip install 'sqlalchemy[asyncio]'` installs 3.5.6.
 *
 * The concrete distribution, not the extra that contains it. `sqlalchemy[asyncio]` is
 * the truer expression of the intent and is not what gets installed, because commands
 * run through `sh -c` and `[` is a glob character there — an argument whose expansion
 * depends on what files the repository happens to contain is not an argument worth
 * having. Widening the command whitelist for it would trade a real boundary for
 * tidiness. The cost is that this drifts if the extra ever gains a second member, which
 * is a thing to notice rather than a thing to guess about now.
 *
 * Strictly, the repository under-declared: it should say `sqlalchemy[asyncio]`. That is
 * the same verdict the missing-package rule already reached about a repository importing
 * `flasgger` and listing four other things — right about whose bug it is, and wrong
 * about what DevLaunch can see. The safety argument is the same too: the requirement
 * comes from a module the project's own source imports, never from a log line, and it is
 * added beside the manifest rather than over it.
 *
 * One entry per submodule genuinely unusable without it, each able to name the
 * repository that proved it. A guessed entry adds a download to every run that imports
 * a popular package.
 */
export function impliedRequirements(
  source: string,
  local: readonly string[] = [],
): { requirement: string; because: string }[] {
  const own = new Set(local);
  const out: { requirement: string; because: string }[] = [];

  forEachImportedModule(source, (module) => {
    if (own.has(module.split('.')[0]!)) return;
    for (const [submodule, requirement] of Object.entries(REQUIRED_BY_MODULE)) {
      // The submodule itself, or anything under it: `sqlalchemy.ext.asyncio.session`
      // needs greenlet for the same reason its parent does.
      if (module !== submodule && !module.startsWith(`${submodule}.`)) continue;
      // The importing module travels with it. A warning saying only "installing
      // greenlet" is a thing DevLaunch did; one saying which import asked for it is a
      // thing somebody can check, disagree with, or fix in their own manifest.
      if (!out.some((r) => r.requirement === requirement)) {
        out.push({ requirement, because: submodule });
      }
    }
  });

  return out;
}

/**
 * A submodule that does not work unless something its parent does not install is there.
 *
 * `sqlalchemy.ext.asyncio` needs greenlet, which SQLAlchemy declares under its `asyncio`
 * extra and installs no other way — found by `fixtures/python-async-postgres`, whose
 * requirements.txt names plain `sqlalchemy`, exactly as the repositories it stands for do.
 */
const REQUIRED_BY_MODULE: Readonly<Record<string, string>> = Object.freeze({
  'sqlalchemy.ext.asyncio': 'greenlet',
});

/** Every module named by an import in this file, with its dots intact. */
function forEachImportedModule(source: string, visit: (module: string) => void): void {
  for (const line of source.split('\n')) {
    // A leading dot is a relative import and never a distribution.
    const from = /^\s*from\s+([A-Za-z_][\w.]*)\s+import\b/.exec(line);
    if (from) {
      visit(from[1]!);
      continue;
    }
    const plain = /^\s*import\s+(.+)$/.exec(line);
    if (!plain) continue;
    for (const part of plain[1]!.split(',')) {
      const name = /^\s*([A-Za-z_][\w.]*)/.exec(part);
      if (name) visit(name[1]!);
    }
  }
}

/**
 * Modules the repository provides that this file imports.
 *
 * The companion to the above, and the reason it exists: a FastAPI tutorial's `main.py`
 * imports `fastapi` and `models`, and `models.py` is where `sqlalchemy` appears. Reading
 * only the entry file installed two of the three distributions the application needs
 * and the run died on `No module named 'sqlalchemy'`. Following the repository's own
 * imports is not a guess — it is the same declaration, one file further along.
 */
export function localImports(source: string, local: readonly string[]): string[] {
  const own = new Set(local);
  const out = new Set<string>();

  const add = (module: string): void => {
    const top = module.split('.')[0]!;
    if (own.has(top)) out.add(top);
  };

  for (const line of source.split('\n')) {
    const from = /^\s*from\s+([A-Za-z_][\w.]*)\s+import\b/.exec(line);
    if (from) {
      add(from[1]!);
      continue;
    }
    const plain = /^\s*import\s+(.+)$/.exec(line);
    if (!plain) continue;
    for (const part of plain[1]!.split(',')) {
      const name = /^\s*([A-Za-z_][\w.]*)/.exec(part);
      if (name) add(name[1]!);
    }
  }

  return [...out];
}

/**
 * Drivers a SQLAlchemy URL scheme requires, which nothing in the source imports.
 *
 * `create_engine("postgresql://...")` loads psycopg2 by name at connect time, so the
 * import scan never sees it and a project planned from its imports installs everything
 * it needs except the driver — then dies on `No module named 'psycopg2'`. The URL scheme
 * is the declaration; this reads it.
 */
const DRIVER_FOR_SCHEME: Readonly<Record<string, string>> = Object.freeze({
  postgresql: 'psycopg2-binary',
  postgres: 'psycopg2-binary',
  'postgresql+psycopg2': 'psycopg2-binary',
  'postgresql+asyncpg': 'asyncpg',
  'postgresql+psycopg': 'psycopg',
  mysql: 'pymysql',
  'mysql+pymysql': 'pymysql',
  'mysql+mysqldb': 'mysqlclient',
  'mysql+aiomysql': 'aiomysql',
});

/** Database drivers a file's connection URLs imply, in the order the URLs appear. */
export function driversForConnectionUrls(source: string): string[] {
  const out: string[] = [];
  // Only inside a string literal: a scheme in a comment is documentation, and a scheme
  // in a variable name is not a URL at all.
  for (const m of source.matchAll(/['"`]([a-z0-9]+(?:\+[a-z0-9_]+)?):\/\/[^'"`\s]*['"`]/gi)) {
    const driver = DRIVER_FOR_SCHEME[m[1]!.toLowerCase()];
    if (driver && !out.includes(driver)) out.push(driver);
  }
  return out;
}

/**
 * A database URL written into the source with a loopback host.
 *
 * `SQLALCHEMY_DATABASE_URL = "postgresql://user:pw@localhost/db"` reads no environment
 * variable, so there is nothing for DevLaunch to set — and inside a container
 * `localhost` is the application itself, so a provisioned database sits unreachable
 * beside it. The failure that follows is `connection to server at "localhost" (::1),
 * port 5432 failed: Connection refused`, which is accurate and explains nothing.
 */
export function hardcodedDatabaseUrl(source: string): string | undefined {
  const m = /['"`]((?:postgres(?:ql)?|mysql|mongodb|redis)(?:\+[a-z0-9_]+)?:\/\/[^'"`\s]*@?(?:localhost|127\.0\.0\.1)[^'"`\s]*)['"`]/i.exec(
    source,
  );
  return m?.[1];
}
