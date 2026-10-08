/**
 * The lowest Python version a project says it needs, and where it says so.
 *
 * Only a *floor*, read from the places projects actually state one. `robstermarinho/
 * django-react-docker-stack` states 3.13 three ways — `requires-python = ">=3.13"`, every
 * requirement marked `; python_version >= "3.13"` (what `poetry export` writes), and
 * `FROM python:3.13-slim` — and run on 3.12, pip printed "Ignoring django: markers ... don't
 * match your environment" for every line, installed nothing, and the backend died on
 * `No module named 'django'`. No repair could have helped: the version was the problem.
 */

export interface PythonFloor {
  /** `3.13`, as major.minor. */
  version: string;
  /** Where it was read, for the plan's warning. */
  evidence: string;
}

export interface PythonVersionSources {
  pyproject?: string | null;
  pythonVersionFile?: string | null;
  runtimeTxt?: string | null;
  requirementsTxt?: string | null;
  dockerfile?: string | null;
}

const asMinor = (major: string, minor: string) => `${Number(major)}.${Number(minor)}`;

/** Compare major.minor versions. */
function newer(a: string, b: string): boolean {
  const [am, an] = a.split('.').map(Number);
  const [bm, bn] = b.split('.').map(Number);
  return am! > bm! || (am === bm && an! > bn!);
}

export function pythonVersionFloor(src: PythonVersionSources): PythonFloor | undefined {
  const found: PythonFloor[] = [];

  // `requires-python = ">=3.13"`, and Poetry's `python = "^3.13"` / `">=3.13,<4"`.
  if (src.pyproject) {
    const req = /^\s*requires-python\s*=\s*["']([^"']+)["']/m.exec(src.pyproject)?.[1];
    const poetry = /^\[tool\.poetry\.dependencies\][^[]*?^\s*python\s*=\s*["']([^"']+)["']/ms.exec(src.pyproject)?.[1];
    for (const [spec, where] of [[req, 'requires-python in pyproject.toml'], [poetry, 'python in [tool.poetry.dependencies]']] as const) {
      if (!spec) continue;
      const m = /(?:>=|\^|~=|~|==)\s*3\.(\d+)/.exec(spec);
      if (m) found.push({ version: asMinor('3', m[1]!), evidence: `${where} (${spec})` });
    }
  }

  // `.python-version` (pyenv, uv): `3.13`, `3.13.1`.
  const pv = /^\s*(?:python-?)?3\.(\d+)/m.exec(src.pythonVersionFile ?? '');
  if (pv) found.push({ version: asMinor('3', pv[1]!), evidence: `.python-version (${src.pythonVersionFile!.trim()})` });

  // Heroku's `runtime.txt`: `python-3.13.0`.
  const rt = /python-3\.(\d+)/.exec(src.runtimeTxt ?? '');
  if (rt) found.push({ version: asMinor('3', rt[1]!), evidence: `runtime.txt (${src.runtimeTxt!.trim()})` });

  // Requirements whose every line is marked for a newer Python — what an exported lock
  // file looks like. Every line, not one: a single `; python_version >= "3.11"` on a
  // backport says nothing about the project.
  if (src.requirementsTxt) {
    const lines = src.requirementsTxt.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith('-'));
    const floors = lines.map((l) => /python_version\s*>=?\s*["']3\.(\d+)["']/.exec(l)?.[1]);
    if (lines.length >= 3 && floors.every((f) => f !== undefined)) {
      const lowest = Math.min(...floors.map(Number));
      found.push({ version: asMinor('3', String(lowest)), evidence: `every line of requirements.txt is marked python_version >= "3.${lowest}"` });
    }
  }

  // The project's own image.
  const df = /^\s*FROM\s+(?:docker\.io\/)?(?:library\/)?python:3\.(\d+)/im.exec(src.dockerfile ?? '');
  if (df) found.push({ version: asMinor('3', df[1]!), evidence: `its Dockerfile uses python:3.${df[1]}` });

  return found.reduce<PythonFloor | undefined>((best, f) => (!best || newer(f.version, best.version) ? f : best), undefined);
}

/**
 * The image version to run: the lowest available that meets the floor, or the default.
 * Nothing high enough: the default, and the plan says what was asked for.
 */
export function pythonImageVersion(floor: PythonFloor | undefined, available: readonly string[], fallback: string): string {
  if (!floor) return fallback;
  const sorted = [...available].sort((a, b) => (newer(a, b) ? 1 : -1));
  return sorted.find((v) => v === floor.version || newer(v, floor.version)) ?? fallback;
}
