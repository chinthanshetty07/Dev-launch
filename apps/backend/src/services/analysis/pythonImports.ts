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
 * Third-party distributions a source file declares it needs, in import order.
 *
 * Relative imports are skipped — `from .models import Note` is the repository's own
 * code — and so is anything the repository itself provides, which the caller supplies
 * as `local`.
 */
export function importedDistributions(source: string, local: readonly string[] = []): string[] {
  const own = new Set(local);
  const out: string[] = [];

  const add = (module: string): void => {
    const top = module.split('.')[0]!;
    if (!top || STDLIB.has(top) || own.has(top)) return;
    // A conditional or lazily-imported name is still a name pip must fetch, but one
    // that is not a valid distribution name never is.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(top)) return;
    const dist = DISTRIBUTION_FOR[top] ?? top;
    if (!out.includes(dist)) out.push(dist);
  };

  for (const line of source.split('\n')) {
    // A leading dot is a relative import and never a distribution.
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

  return out;
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
