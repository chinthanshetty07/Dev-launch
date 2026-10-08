import { describe, it, expect } from 'vitest';
import { summarise } from '../services/analysis/ComposeFile.js';

/**
 * A compose file is the only signal in a repository that is a *declaration* rather than
 * an inference. Every failure that sent DevLaunch down the AI-fallback path on a complex
 * repository had one sitting unread at the root.
 */

const PGRAG = `
services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: pgrag
    ports:
      - "5432:5432"
  mcp:
    build: ./app/backend
    command: ["uv", "run", "python", "-m", "pg_rag.mcp_integration.server"]
    ports:
      - "8001:8001"
    environment:
      DATABASE_URL: postgresql+asyncpg://postgres:postgres@postgres:5432/pgrag
      MCP_AUTH_TOKEN: \${MCP_AUTH_TOKEN:-}
    depends_on:
      postgres:
        condition: service_healthy
  backend:
    build: ./app/backend
    ports:
      - "8000:8000"
    environment:
      DATABASE_URL: postgresql+asyncpg://postgres:postgres@postgres:5432/pgrag
      MCP_SERVER_URL: http://mcp:8001/mcp
    depends_on:
      postgres:
        condition: service_healthy
  frontend:
    build: ./app/frontend
    ports:
      - "3000:80"
    depends_on:
      - backend
`;

describe('what the author already wrote down', () => {
  it('finds the services, their directories and the commands they run', () => {
    // The guess this replaces, from a real run: `pip install -e .` at a repository root
    // containing no Python package. The code was two directories down, in a path this
    // file names outright.
    const c = summarise(PGRAG)!;
    const byName = Object.fromEntries(c.services.map((s) => [s.name, s]));

    expect(Object.keys(byName).sort()).toEqual(['backend', 'frontend', 'mcp']);
    expect(byName.backend!.dir).toBe('app/backend');
    expect(byName.frontend!.dir).toBe('app/frontend');
    expect(byName.mcp!.command).toBe('uv run python -m pg_rag.mcp_integration.server');
  });

  it('reads the published mapping the right way round', () => {
    // `3000:80` is host 3000, container 80. Reversed, DevLaunch waits for readiness on a
    // port nothing is listening on and reports the application as broken.
    const c = summarise(PGRAG)!;
    const frontend = c.services.find((s) => s.name === 'frontend')!;
    expect(frontend.containerPort).toBe(80);
    expect(frontend.hostPort).toBe(3000);
    expect(c.services.find((s) => s.name === 'backend')!.containerPort).toBe(8000);
  });

  it('knows which one the browser opens', () => {
    const c = summarise(PGRAG)!;
    expect(c.services.find((s) => s.name === 'frontend')!.role).toBe('web');
    expect(c.services.find((s) => s.name === 'backend')!.role).toBe('api');
  });

  it('keeps the database image the author chose, not a generic one', () => {
    // A project using pgvector needs `pgvector/pgvector`; plain `postgres:16` starts
    // happily and then fails the application's first `CREATE EXTENSION vector`. The
    // difference is invisible until the app runs, and the file states it outright.
    const c = summarise(PGRAG)!;
    expect(c.backing).toHaveLength(1);
    expect(c.backing[0]!.kind).toBe('postgres');
    expect(c.backing[0]!.image).toBe('pgvector/pgvector:pg16');
    expect((c.backing[0] as { database?: string }).database).toBe('pgrag');
  });

  it('drops shell interpolations but remembers the variable was named', () => {
    // `${MCP_AUTH_TOKEN:-}` resolves from a shell DevLaunch does not have. Passing it
    // through sets the variable to the literal text `${MCP_AUTH_TOKEN:-}`, which is
    // worse than leaving it unset: the application then believes it is configured.
    const mcp = summarise(PGRAG)!.services.find((s) => s.name === 'mcp')!;
    expect(mcp.environment.MCP_AUTH_TOKEN).toBeUndefined();
    expect(mcp.environment.DATABASE_URL).toBe('postgresql+asyncpg://postgres:postgres@postgres:5432/pgrag');
    expect(mcp.declaredKeys).toContain('MCP_AUTH_TOKEN');
    // Named once, however many places it appears.
    expect(mcp.declaredKeys.filter((k) => k === 'DATABASE_URL')).toHaveLength(1);
  });

  it('reads depends_on in both spellings', () => {
    const c = summarise(PGRAG)!;
    expect(c.services.find((s) => s.name === 'backend')!.dependsOn).toContain('postgres');
    expect(c.services.find((s) => s.name === 'frontend')!.dependsOn).toEqual(['backend']);
  });

  it('treats a service with no published port as a worker', () => {
    const c = summarise(`
services:
  api:
    build: .
    ports: ["8000:8000"]
  worker:
    build: .
    command: celery -A app worker
`)!;
    expect(c.services.find((s) => s.name === 'worker')!.role).toBe('worker');
  });

  it('returns nothing rather than guessing at a file it cannot read', () => {
    expect(summarise('this: is: not: valid: yaml:')).toBeNull();
    expect(summarise('version: "3"')).toBeNull();
  });
});

describe('a reverse proxy in front', () => {
  // `jamall-mahmoudi-dev/django-react-production-stack`, as its compose file has it: nginx
  // depends on the React app it serves, which made the React app look like something other
  // services call — an API — and its page was never treated as the page.
  const BEHIND_NGINX = `
services:
  django:
    build: ./backend
    ports: ["8000:8000"]
  react:
    build: ./frontend
    ports: ["3000:3000"]
  nginx:
    build: ./nginx
    ports: ["8080:80"]
    depends_on: [django, react]
`;
  it('does not make the services it fronts look like APIs', () => {
    const c = summarise(BEHIND_NGINX)!;
    expect(c.services.find((s) => s.name === 'react')!.role).toBe('web');
    expect(c.services.find((s) => s.name === 'django')!.role).toBe('api');
  });
});
