import { describe, it, expect } from 'vitest';
import { impliedRequirements, importedDistributions } from '../services/analysis/pythonImports.js';

/**
 * Reading imports is the last resort for a project that declares nothing, and the one
 * place a rule installs packages nobody wrote down. The risk it carries is specific:
 * a name that is not a distribution fails the whole install, so what is *excluded*
 * matters more here than what is found.
 */
describe('distributions a Python file declares by importing them', () => {
  it('finds third-party imports in both spellings', () => {
    const out = importedDistributions(`
from flask import Flask
import flask_sqlalchemy
from flask_sqlalchemy import SQLAlchemy
`);
    expect(out).toEqual(['flask', 'flask_sqlalchemy']);
  });

  it('never installs the standard library', () => {
    // `pip install os` fails, and it fails the whole command with it.
    const out = importedDistributions(`
import os, sys, json
from datetime import datetime
from typing import Optional
import sqlite3
from flask import Flask
`);
    expect(out).toEqual(['flask']);
  });

  it('never installs the repository\'s own modules', () => {
    // `models.py` sits beside app.py; there is nothing on PyPI to fetch for it.
    const out = importedDistributions(
      'from models import Note\nimport helpers\nimport requests\n',
      ['models', 'helpers', 'app'],
    );
    expect(out).toEqual(['requests']);
  });

  it('skips relative imports', () => {
    const out = importedDistributions('from .api import router\nfrom ..db import engine\n');
    expect(out).toEqual([]);
  });

  it('uses the distribution name when it differs from the import name', () => {
    // `pip install cv2` does not exist; `opencv-python` is what provides it.
    const out = importedDistributions('import cv2\nimport yaml\nfrom dotenv import load_dotenv\n');
    expect(out).toEqual(['opencv-python', 'pyyaml', 'python-dotenv']);
  });

  it('takes only the top-level package of a dotted import', () => {
    const out = importedDistributions('from sqlalchemy.orm import declarative_base\n');
    expect(out).toEqual(['sqlalchemy']);
  });

  it('reports each distribution once, in import order', () => {
    const out = importedDistributions('import requests\nimport flask\nimport requests\n');
    expect(out).toEqual(['requests', 'flask']);
  });

  it('ignores a word that merely follows the word import', () => {
    // Prose in a docstring is not a declaration.
    const out = importedDistributions('"""You should import pandas first."""\nimport flask\n');
    expect(out).toEqual(['flask']);
  });
});

describe('drivers a connection URL names but nothing imports', () => {
  it('reads the driver out of a SQLAlchemy URL scheme', async () => {
    // `create_engine("postgresql://...")` loads psycopg2 by name at connect time, so no
    // import scan sees it. A project planned from its imports installed everything it
    // needed except the driver and died on `No module named 'psycopg2'`.
    const { driversForConnectionUrls } = await import('../services/analysis/pythonImports.js');
    expect(driversForConnectionUrls('URL = "postgresql://u:p@localhost/db"')).toEqual([
      'psycopg2-binary',
    ]);
  });

  it('distinguishes the async dialect, which is a different distribution', async () => {
    const { driversForConnectionUrls } = await import('../services/analysis/pythonImports.js');
    expect(driversForConnectionUrls("u = 'postgresql+asyncpg://x/y'")).toEqual(['asyncpg']);
  });

  it('ignores a scheme that names no driver', async () => {
    // SQLite needs nothing, and an http:// URL is not a database at all.
    const { driversForConnectionUrls } = await import('../services/analysis/pythonImports.js');
    expect(driversForConnectionUrls('a = "sqlite:///./app.db"\nb = "https://example.com"')).toEqual([]);
  });

  it('ignores a scheme outside a string literal', async () => {
    // A scheme in prose is documentation, not a connection.
    const { driversForConnectionUrls } = await import('../services/analysis/pythonImports.js');
    expect(driversForConnectionUrls('# set DATABASE_URL to postgresql://host/db')).toEqual([]);
  });
});

describe('a database URL written into the source', () => {
  it('finds a loopback connection string a literal cannot be redirected from', async () => {
    const { hardcodedDatabaseUrl } = await import('../services/analysis/pythonImports.js');
    expect(
      hardcodedDatabaseUrl('SQLALCHEMY_DATABASE_URL = "postgresql://postgres:pw@localhost/TodoDb"'),
    ).toBe('postgresql://postgres:pw@localhost/TodoDb');
  });

  it('says nothing about a URL that already points at a reachable host', async () => {
    // `@db` or `@postgres` is a container alias, which is what working configuration
    // looks like. Warning about it would be noise.
    const { hardcodedDatabaseUrl } = await import('../services/analysis/pythonImports.js');
    expect(hardcodedDatabaseUrl('URL = "postgresql://u:p@db:5432/x"')).toBeUndefined();
  });

  it('says nothing when the URL comes from the environment', async () => {
    const { hardcodedDatabaseUrl } = await import('../services/analysis/pythonImports.js');
    expect(hardcodedDatabaseUrl('URL = os.getenv("DATABASE_URL")')).toBeUndefined();
  });
});

/**
 * A part of a distribution that its parent does not install.
 *
 * `importedDistributions` reduces every import to the name pip installs, which is right
 * for installing and throws away the only evidence that a *submodule* was asked for.
 * `fixtures/python-async-postgres` declares plain `sqlalchemy` and imports
 * `sqlalchemy.ext.asyncio`; the install succeeded, the server started, and the first
 * query died with "the SQLAlchemy asyncio module requires that the Python 'greenlet'
 * library is installed". Measured in the runner image: `pip install sqlalchemy asyncpg`
 * leaves no greenlet, `pip install 'sqlalchemy[asyncio]'` installs 3.5.6.
 */
describe('requirements a submodule implies', () => {
  it('reads greenlet out of an async SQLAlchemy import', () => {
    const source = 'from sqlalchemy.ext.asyncio import create_async_engine\n';
    expect(impliedRequirements(source)).toEqual([
      { requirement: 'greenlet', because: 'sqlalchemy.ext.asyncio' },
    ]);
  });

  it('says nothing about the synchronous half of the same distribution', () => {
    // The overwhelmingly common case, and the one where an extra download every run
    // would be pure cost. `sqlalchemy` alone works perfectly without greenlet.
    expect(impliedRequirements('from sqlalchemy import create_engine, text\n')).toEqual([]);
    expect(impliedRequirements('import sqlalchemy\n')).toEqual([]);
  });

  it('matches anything under the submodule, not only the submodule itself', () => {
    // `sqlalchemy.ext.asyncio.session` needs greenlet for the same reason its parent does.
    expect(impliedRequirements('from sqlalchemy.ext.asyncio.session import AsyncSession\n')).toEqual([
      { requirement: 'greenlet', because: 'sqlalchemy.ext.asyncio' },
    ]);
  });

  it('does not confuse a prefix for a submodule', () => {
    // `sqlalchemy.ext.asyncioqueue` is not under `sqlalchemy.ext.asyncio`, and a
    // startsWith without the dot would say it was.
    expect(impliedRequirements('import sqlalchemy.ext.asyncioqueue\n')).toEqual([]);
  });

  it('leaves the repository\'s own modules alone', () => {
    // A local package called `sqlalchemy` is somebody\'s own code, however unwise.
    expect(impliedRequirements('from sqlalchemy.ext.asyncio import x\n', ['sqlalchemy'])).toEqual([]);
  });

  it('names each requirement once, however many files ask for it', () => {
    const source = [
      'from sqlalchemy.ext.asyncio import create_async_engine',
      'from sqlalchemy.ext.asyncio import AsyncSession',
    ].join('\n');
    expect(impliedRequirements(source)).toHaveLength(1);
  });
});
