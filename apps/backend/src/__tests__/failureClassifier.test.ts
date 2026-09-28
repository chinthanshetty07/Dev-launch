import { describe, it, expect } from 'vitest';
import { FailureCode, type FailureDetail } from '@devlaunch/shared';
import { FailureClassifier } from '../services/failures/FailureClassifier.js';
import { SIGNATURES } from '../services/failures/signatures.js';

const classifier = new FailureClassifier();

const fallback: FailureDetail = {
  code: FailureCode.DEPENDENCY_INSTALL_FAILED,
  message: 'Dependency installation failed.',
};

const classify = (logs: string, phase: 'install' | 'build' | 'start' = 'install', exitCode = 1) =>
  classifier.classify({ logs, phase, exitCode, fallback });

describe('FailureClassifier — signatures', () => {
  it.each([
    ['JavaScript heap out of memory', 'FATAL ERROR: Reached heap limit\nJavaScript heap out of memory', FailureCode.OUT_OF_MEMORY],
    ['bare Killed line', 'installing...\nKilled', FailureCode.OUT_OF_MEMORY],
    ['disk full', 'npm ERR! ENOSPC: no space left on device', FailureCode.DEPENDENCY_INSTALL_FAILED],
    ['exec format error', '/app/bin/tool: Exec format error', FailureCode.ARCH_INCOMPATIBLE],
    ['no prebuilt binaries', 'sharp: no prebuilt binaries available for this platform', FailureCode.ARCH_INCOMPATIBLE],
    ['EBADPLATFORM', 'npm ERR! code EBADPLATFORM', FailureCode.ARCH_INCOMPATIBLE],
    ['peer conflict', 'npm ERR! ERESOLVE unable to resolve dependency tree', FailureCode.DEPENDENCY_INSTALL_FAILED],
    ['node-gyp', 'gyp ERR! build error', FailureCode.DEPENDENCY_INSTALL_FAILED],
    ['missing pypi package', 'ERROR: Could not find a version that satisfies the requirement foo', FailureCode.DEPENDENCY_INSTALL_FAILED],
    ['dns failure', 'npm ERR! getaddrinfo EAI_AGAIN registry.npmjs.org', FailureCode.NETWORK_FAILURE],
    ['tls failure', 'pip: SSL: CERTIFICATE_VERIFY_FAILED', FailureCode.NETWORK_FAILURE],
    ['bad engine', 'npm ERR! code EBADENGINE', FailureCode.WRONG_RUNTIME_VERSION],
    ['python version', 'ERROR: Package requires Python >=3.13', FailureCode.WRONG_RUNTIME_VERSION],
  ])('classifies %s', (_label, logs, expected) => {
    expect(classify(logs).code).toBe(expected);
  });

  it.each([
    ['postgres refused', 'Error: connect ECONNREFUSED 127.0.0.1:5432'],
    ['redis refused', 'Error: connect ECONNREFUSED 10.0.0.5:6379'],
    ['unresolvable db host', 'Error: getaddrinfo ENOTFOUND postgres'],
    ['django operational error', 'django.db.utils.OperationalError: could not connect to server'],
    ['mongo', 'MongoNetworkError: failed to connect'],
  ])('classifies %s as a missing database', (_label, logs) => {
    expect(classify(logs, 'start').code).toBe(FailureCode.DATABASE_REQUIRED);
  });

  it('prefers a database diagnosis over a generic network one', () => {
    // Both signatures could fire. Reporting NETWORK_FAILURE would send the user to
    // check connectivity rather than to the real answer: the project needs a database.
    const logs = 'getaddrinfo EAI_AGAIN something\nError: connect ECONNREFUSED 127.0.0.1:5432';
    expect(classify(logs, 'start').code).toBe(FailureCode.DATABASE_REQUIRED);
  });

  it.each([
    ['django secret key', 'ImproperlyConfigured: The SECRET_KEY setting must not be empty'],
    ['explicit message', 'Error: Missing required environment variable REQUIRED_TOKEN'],
    ['python KeyError', "KeyError: 'DATABASE_URL'"],
    // The other word order. The OpenAI SDK says it this way at import time, and it was
    // landing as a low-confidence generic start failure with the name in plain sight.
    ['openai at import', 'openai.OpenAIError: Missing credentials. Please pass an `api_key`, or set the `OPENAI_API_KEY` or `OPENAI_ADMIN_KEY` environment variable.'],
    ['set-the phrasing', 'Error: please set the STRIPE_SECRET environment variable'],
  ])('classifies %s as missing configuration', (_label, logs) => {
    expect(classify(logs, 'start').code).toBe(FailureCode.MISSING_ENV);
  });

  it('names the variable the OpenAI SDK asks for', () => {
    const out = classify(
      'openai.OpenAIError: Missing credentials. Please pass an `api_key`, or set the `OPENAI_API_KEY` or `OPENAI_ADMIN_KEY` environment variable.',
      'start',
    );
    expect(out.code).toBe(FailureCode.MISSING_ENV);
    expect(out.confidence).toBe('high');
    expect(out.evidence).toContain('OPENAI_API_KEY');
  });

  it.each([
    ['node', "Error: Cannot find module 'express'"],
    ['esm', 'ERR_MODULE_NOT_FOUND'],
    ['python', "ModuleNotFoundError: No module named 'flask'"],
  ])('classifies a missing module at start (%s)', (_label, logs) => {
    expect(classify(logs, 'start').code).toBe(FailureCode.START_COMMAND_FAILED);
  });

  it('classifies a missing start command', () => {
    const out = classify('/bin/sh: 1: flask: not found', 'start', 127);
    expect(out.code).toBe(FailureCode.START_COMMAND_FAILED);
    expect(out.remedy).toMatch(/\$HOME\/\.local\/bin/);
  });
});

describe('FailureClassifier — behaviour', () => {
  it('returns the evidence line, so a verdict can be checked rather than trusted', () => {
    const out = classify('line one\nnpm ERR! code EBADPLATFORM\nline three');
    expect(out.evidence).toContain('EBADPLATFORM');
    expect(out.confidence).toBe('high');
    expect(out.remedy).toBeTruthy();
  });

  it('takes the last matching line, since errors accumulate', () => {
    const out = classify("Cannot find module 'a'\nCannot find module 'b'", 'start');
    expect(out.evidence).toContain("'b'");
  });

  it('treats exit 137 with no output as the memory ceiling', () => {
    // The OOM killer gives the process no chance to explain itself.
    const out = classifier.classify({ logs: 'installing...', phase: 'install', exitCode: 137, fallback });
    expect(out.code).toBe(FailureCode.OUT_OF_MEMORY);
    expect(out.confidence).toBe('medium');
  });

  it('admits when it has no diagnosis instead of inventing one', () => {
    // The original form of this test also required `evidence` to be undefined, on the
    // reading that anything in that field amounts to a claim. That conflated two
    // different things. Withholding a verdict is honesty; withholding what the program
    // said is silence — and it produced reports that read, in full, `Start command
    // exited with code 1.` on a run whose log ends `RuntimeError: Working outside of
    // application context.`
    //
    // What must not be invented is the *verdict*: the code stays the coarse fallback,
    // the confidence stays low, and no remedy is offered for a cause nobody identified.
    const out = classify('some entirely unremarkable output');
    expect(out.code).toBe(fallback.code);
    expect(out.confidence).toBe('low');
    expect(out.remedy).toBeUndefined();
  });

  it('quotes the last thing the application said, even with no diagnosis', () => {
    const out = classify(
      'Traceback (most recent call last):\n' +
        '  File "/workspace/app.py", line 25, in <module>\n' +
        '    db.create_all()\n' +
        'RuntimeError: Working outside of application context.',
    );
    expect(out.confidence).toBe('low');
    expect(out.evidence).toBe('RuntimeError: Working outside of application context.');
  });

  it('prefers the exception over the paragraph a runtime prints after it', () => {
    // Flask's message continues for three lines past the exception, and the last of them
    // — "See the documentation for more information." — is true and says nothing.
    const out = classify(
      'RuntimeError: Working outside of application context.\n' +
        'This typically means that you attempted to use functionality that needed\n' +
        'the current application. To solve this, set up an application context\n' +
        'with app.app_context(). See the documentation for more information.',
    );
    expect(out.evidence).toBe('RuntimeError: Working outside of application context.');
  });

  it('recognises a dotted exception name', () => {
    // `sqlalchemy.exc.IntegrityError`, `django.core.exceptions.ImproperlyConfigured`:
    // the module path is part of the name, and an anchored `^Word:` pattern misses them.
    const out = classify(
      'sqlalchemy.exc.IntegrityError: duplicate key value violates a unique constraint\n' +
        'Some trailing note from the runner.',
    );
    expect(out.evidence).toMatch(/IntegrityError/);
  });

  it('walks past the stack frames to the line that names the problem', () => {
    // A traceback's final line is the exception; the frames above it are how it got
    // there, and quoting one of those says nothing.
    const out = classify(
      'ValueError: bad thing happened\n  File "/workspace/x.py", line 3, in <module>\n    at Object.<anonymous>',
    );
    expect(out.evidence).toBe('ValueError: bad thing happened');
  });

  it('respects the phase a signature applies to', () => {
    // A peer-dependency conflict cannot occur during start.
    const logs = 'npm ERR! ERESOLVE unable to resolve dependency tree';
    expect(classify(logs, 'install').confidence).toBe('high');
    expect(classify(logs, 'start').confidence).toBe('low');
  });

  it('accepts structured log entries as well as raw text', () => {
    const out = classifier.classify({
      logs: [{ seq: 0, ts: 1, stream: 'stderr', text: 'npm ERR! code EBADENGINE' }],
      phase: 'install',
      fallback,
    });
    expect(out.code).toBe(FailureCode.WRONG_RUNTIME_VERSION);
  });

  it('gives every signature a remedy', () => {
    // Guard the loop itself: with an empty table the body never runs and the
    // assertions below are vacuously true, so this test would stay green even if
    // every signature were deleted.
    expect(SIGNATURES.length).toBeGreaterThan(10);

    // A classification with no suggested action is only half a diagnosis.
    for (const sig of SIGNATURES) {
      expect(sig.remedy.length, `${sig.id} needs a remedy`).toBeGreaterThan(20);
      expect(sig.patterns.length, `${sig.id} needs patterns`).toBeGreaterThan(0);
    }
  });

  it('summarises for display, flagging uncertainty', () => {
    expect(FailureClassifier.summarise(classify('nothing here'))).toMatch(/\(uncertain\)/);
    expect(FailureClassifier.summarise(classify('Killed'))).not.toMatch(/uncertain/);
  });
});

describe('a native build that only needed `python` on PATH', () => {
  const LOG = `.../sqlite3@5.0.2/node_modules/sqlite3 install: gyp info find Python using Python version 3.11.2 found at "/usr/bin/python3"
.../sqlite3@5.0.2/node_modules/sqlite3 install: /bin/sh: 1: python: not found
.../sqlite3@5.0.2/node_modules/sqlite3 install: make: *** [deps/action_before_build.target.mk:13: Release/obj/gen/sqlite-autoconf-3340000/sqlite3.c] Error 127
.../sqlite3@5.0.2/node_modules/sqlite3 install: gyp ERR! build error`;

  it('names the missing alias rather than a missing system library', () => {
    // The generic native-build rule matched `gyp ERR!` and sent people after a system
    // library. The Makefile's own line says what was missing, three lines up.
    const out = classify(LOG, 'install');
    expect(out.code).toBe(FailureCode.DEPENDENCY_INSTALL_FAILED);
    expect(out.message).toMatch(/needs `python` on PATH/);
    expect(out.remedy).toMatch(/python-is-python3/);
    expect(out.evidence).toMatch(/python: not found/);
  });

  it('still reports a genuine compiler failure generically', () => {
    const out = classify('gyp ERR! build error\ngyp ERR! stack Error: `make` failed with exit code: 2', 'install');
    expect(out.message).toMatch(/native code failed to build/);
  });
});

describe('a pyproject that is not a distribution', () => {
  const LOG = `Processing /workspace
  Getting requirements to build wheel: finished with status 'error'
      error: Multiple top-level packages discovered in a flat-layout: ['app', 'certs', 'resources'].
      To avoid accidental inclusion of unwanted files or directories,
note: This error originates from a subprocess, and is likely not a problem with pip.`;

  it('says the project is not a package, not that installation is a mystery', () => {
    const out = classify(LOG, 'install');
    expect(out.code).toBe(FailureCode.DEPENDENCY_INSTALL_FAILED);
    expect(out.confidence).toBe('high');
    expect(out.message).toMatch(/cannot be installed as a package/);
    expect(out.remedy).toMatch(/declared dependencies by name/);
  });
});

describe('a Node crash', () => {
  it('names the module that does not exist, not the watcher\'s epilogue', () => {
    // A real run reported `Failed running 'app.js'` as its entire evidence, four lines
    // below `Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:sqlite`.
    const out = classify(
      "node:internal/modules/esm/translators:391\n" +
        '    throw new ERR_UNKNOWN_BUILTIN_MODULE(url);\n' +
        'Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:sqlite\n' +
        '    at ModuleLoader.builtinStrategy (node:internal/modules/esm/translators:391:11)\n' +
        'Node.js v20.20.2\n' +
        "Failed running 'app.js'",
      'start',
    );
    expect(out.code).toBe(FailureCode.WRONG_RUNTIME_VERSION);
    expect(out.evidence).toMatch(/node:sqlite/);
  });

  it('quotes a bracketed Node error when no signature claims it', () => {
    // Node writes `TypeError [ERR_INVALID_ARG_TYPE]: ...`, and an exception pattern that
    // stops at the first space skips the whole line — leaving the evidence to be whatever
    // the runner printed last, which is an epilogue rather than a cause.
    const out = classify(
      'TypeError [ERR_INVALID_ARG_TYPE]: The "path" argument must be of type string\n' +
        '    at Object.readFileSync (node:fs:1234:5)\n' +
        "Failed running 'app.js'",
      'start',
    );
    expect(out.confidence).toBe('low');
    expect(out.evidence).toMatch(/ERR_INVALID_ARG_TYPE/);
  });

  it('is a runtime-version problem, not a port problem', () => {
    // A watcher keeps the container alive after the crash, so the symptom is "nothing is
    // listening" and the cause is a module the running Node does not have. A model was
    // asked to interpret it and rewrote the start command.
    const out = classify('Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:sqlite', 'start');
    expect(out.code).toBe(FailureCode.WRONG_RUNTIME_VERSION);
    expect(out.confidence).toBe('high');
  });
});

/**
 * A package runner's epilogue is not a diagnosis.
 *
 * `nicholasdavidbrown/sern-compose-template` failed with its backend exiting 1, and the
 * report's evidence was `error Command failed with exit code 1.` — yarn restating the
 * exit code, under a heading that already said the command exited 1. The report was the
 * exit code twice and the cause not at all.
 */
describe('what the application said, not what ran it', () => {
  const classify = (lines: string[]) =>
    new FailureClassifier().classify({
      logs: lines.join('\n'),
      exitCode: 1,
      phase: 'start',
      fallback: { code: FailureCode.START_COMMAND_FAILED, message: 'Start command exited with code 1.' },
    });

  it('walks past yarn\'s epilogue to the sentence that names the problem', () => {
    // Deliberately a sentence no signature matches and that is not exception-shaped:
    // the two earlier passes would otherwise find it on their own and this would test
    // nothing. What is left is exactly the case that was broken — an application whose
    // last useful words are prose, followed by the runner's accounting.
    const verdict = classify([
      'yarn run v1.22.22',
      '$ nodemon src/index.js',
      'Configuration is invalid: no database name was supplied and none could be inferred.',
      'error Command failed with exit code 1.',
      'info Visit https://yarnpkg.com/en/docs/cli/run for documentation about this command.',
    ]);
    expect(verdict.evidence).toMatch(/no database name was supplied/);
    expect(verdict.evidence).not.toMatch(/Command failed with exit code/);
  });

  it('walks past npm\'s, which is the same epilogue in a different accent', () => {
    const verdict = classify([
      '> app@1.0.0 start',
      'Fatal: the configuration file names a provider this build does not include.',
      'npm ERR! code ELIFECYCLE',
      'npm ERR! Failed at the app@1.0.0 start script.',
      'npm ERR! This is probably not a problem with npm. There is likely additional logging output above.',
    ]);
    expect(verdict.evidence).toMatch(/names a provider/);
    expect(verdict.evidence).not.toMatch(/npm ERR!/);
  });

  it('walks past the runtime\'s own sign-off, which is the last line of every crash', () => {
    // Node prints its version after an uncaught error, so `Node.js v20.20.2` is the
    // final line of every Node crash there is. A live run picked it as the evidence for
    // a real failure — a version number, offered as the cause.
    const verdict = classify([
      '> backend@1.0.0 dev',
      'The database connection string is required but was not provided.',
      '',
      'Node.js v20.20.2',
    ]);
    expect(verdict.evidence).toMatch(/database connection string/);
    expect(verdict.evidence).not.toMatch(/Node\.js v/);
  });

  it('still quotes the runner when the runner is genuinely all there is', () => {
    // Skipping noise must not become withholding evidence. When nothing else was said,
    // the epilogue is a worse answer than a good one and a better answer than silence
    // — but only the heading is left, and it already carries the exit code.
    const verdict = classify(['yarn run v1.22.22', 'error Command failed with exit code 1.']);
    expect(verdict.code).toBe(FailureCode.START_COMMAND_FAILED);
    expect(verdict.confidence).toBe('low');
  });
});

/**
 * A missing module is two different failures wearing the same sentence.
 *
 * `require('express')` that cannot be found is a dependency, and installing it is a
 * plan change a rule can make. `require('./routes/users')` in a repository whose file
 * is `users.js` at the root is the repository being wrong about itself, and no plan
 * reaches it. Conflated, the second one cost a model call, and the model answered by
 * inventing a script that does not exist.
 */
describe('a broken import of the repository\'s own file', () => {
  const classify = (line: string) =>
    new FailureClassifier().classify({
      logs: `Error: ${line}`,
      exitCode: 1,
      phase: 'start',
      fallback: { code: FailureCode.UNKNOWN_RUNTIME_ERROR, message: 'x' },
    });

  it('is told apart from a missing dependency by the leading dot', () => {
    expect(classify("Cannot find module './routes/users'").code).toBe(FailureCode.BROKEN_IMPORT);
    expect(classify("Cannot find module '../lib/db'").code).toBe(FailureCode.BROKEN_IMPORT);
    // And a bare specifier stays what it was: something that can be installed.
    expect(classify("Cannot find module 'express'").code).toBe(FailureCode.START_COMMAND_FAILED);
  });

  it('leaves an absolute path repairable, because it is usually the plan\'s', () => {
    // Node reports a `require` as written and resolves a command-line entry to an
    // absolute path first — so `/workspace/wrong-entry.js` is `node wrong-entry.js`
    // with the wrong file, which a corrected start command fixes and repair is good at.
    // Calling it unrepairable took away the fix for the commonest thing repair does,
    // and an integration test that had exercised that fix for months caught it.
    expect(classify("Cannot find module '/workspace/wrong-entry.js'").code).toBe(
      FailureCode.START_COMMAND_FAILED,
    );
  });

  it('says the remedy is a file, not an install', () => {
    const verdict = classify("Cannot find module './routes/users'");
    expect(verdict.message).toMatch(/one of its own files/);
    expect(verdict.remedy).toMatch(/relative to the file importing it/);
    // Case, because this is the half of it that only bites in a container.
    expect(verdict.remedy).toMatch(/case/);
  });
});
