import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selfSigningReads } from '../services/analysis/ServiceDiscovery.js';

/**
 * The self-signing secrets a service's code reads, in the forms real projects use, so a
 * random local value can be given before the application dies for want of one.
 */
const repo = (files: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), 'devlaunch-ssr-'));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return dir;
};

describe('self-signing secrets a service reads', () => {
  it('finds them however the code reads them', async () => {
    const keys = await selfSigningReads(repo({
      'settings.py': [
        'SECRET_KEY = os.environ.get("SECRET_KEY")',
        "SESSION = os.getenv('SESSION_SECRET', 'dev')",
        "JWT = env('JWT_SECRET')",
        'FLASK = env.str("FLASK_SECRET_KEY")',
        "DJ = config('DJANGO_SECRET_KEY')",
        'ENC = os.environ["ENCRYPTION_KEY"]',
      ].join('\n'),
      'auth.ts': "const a = process.env.NEXTAUTH_SECRET;\nconst b = process.env['COOKIE_SECRET'];\n",
    }));
    expect([...keys].sort()).toEqual([
      'COOKIE_SECRET', 'DJANGO_SECRET_KEY', 'ENCRYPTION_KEY', 'FLASK_SECRET_KEY',
      'JWT_SECRET', 'NEXTAUTH_SECRET', 'SECRET_KEY', 'SESSION_SECRET',
    ]);
  });

  it('finds a Django project\'s settings in the package named after it', async () => {
    // The layout that was missed: `manage.py` at the service's root, settings one folder
    // down in a package with any name. The shared walker reads only source-named folders
    // once the root has files of its own.
    const keys = await selfSigningReads(repo({
      'manage.py': 'import os\nos.environ.setdefault("DJANGO_SETTINGS_MODULE", "api.settings")\n',
      'api/settings.py': 'import os\nSECRET_KEY = os.environ.get("SECRET_KEY")\n',
      'node_modules/x/index.js': 'process.env.JWT_SECRET',
    }));
    expect([...keys]).toEqual(['SECRET_KEY']);
  });

  it('leaves out every other setting, keys to other services above all', async () => {
    const keys = await selfSigningReads(repo({
      'app.py': 'A = os.environ.get("STRIPE_API_KEY")\nB = os.getenv("DATABASE_URL")\nC = os.environ["OPENAI_API_KEY"]\nD = myconfig("SECRET_KEY")\n',
      'README.md': 'set os.environ.get("SECRET_KEY")',
    }));
    expect([...keys]).toEqual([]);
  });
});
