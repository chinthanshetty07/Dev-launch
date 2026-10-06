import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  exposedPorts,
  readDockerSetup,
  readPorts,
  validImageName,
} from '../services/docker/RepoDockerSetup.js';

/**
 * A repository's own Docker setup, run as a fallback at the "balanced" safety level the
 * user chose: the image's own user and a writable disk are allowed; extra privileges, the
 * Docker socket, host folders and host networking are refused — by name, never ignored.
 */

const scratch: string[] = [];
afterAll(async () => {
  await Promise.all(scratch.map((d) => rm(d, { recursive: true, force: true })));
});

async function repo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'devlaunch-dock-'));
  scratch.push(root);
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), contents);
  }
  return root;
}

const setupOf = async (files: Record<string, string>) => {
  const r = await readDockerSetup(await repo(files));
  if (r?.kind !== 'setup') throw new Error(`expected a setup, got ${JSON.stringify(r)}`);
  return r.setup;
};
const refusalOf = async (files: Record<string, string>) => {
  const r = await readDockerSetup(await repo(files));
  if (r?.kind !== 'refused') throw new Error(`expected a refusal, got ${JSON.stringify(r)}`);
  return r.reasons.join('\n');
};

describe('a lone Dockerfile', () => {
  it('is one web service built from the root, on the port it exposes', async () => {
    const s = await setupOf({ Dockerfile: 'FROM golang:1.22\nEXPOSE 8080\nCMD ["/app"]\n' });
    expect(s.source).toBe('dockerfile');
    expect(s.services).toEqual([
      expect.objectContaining({ name: 'app', role: 'web', ports: [8080], build: { context: '.', dockerfile: 'Dockerfile', args: {} } }),
    ]);
  });

  it('is nothing at all when there is neither a Dockerfile nor a compose file', async () => {
    expect(await readDockerSetup(await repo({ 'README.md': '' }))).toBeNull();
  });

  it('reads EXPOSE in every form, and never a UDP port', () => {
    expect(exposedPorts('EXPOSE 80/tcp 443\nexpose 3000\nEXPOSE 53/udp\n')).toEqual([80, 443, 3000]);
  });
});

describe('a compose file', () => {
  const compose = `
services:
  web:
    build: ./frontend
    ports: ["3000:80"]
    depends_on: [api]
  api:
    build:
      context: ./backend
      dockerfile: Dockerfile.prod
      args: { MODE: production, TOKEN: "\${TOKEN}" }
    environment:
      DATABASE_URL: postgres://app:app@db:5432/app
      SECRET: \${SECRET}
    ports: ["8000"]
    depends_on: { db: { condition: service_healthy } }
    volumes: ["./backend:/code"]
  db:
    image: postgres:16
    environment: [POSTGRES_PASSWORD=app, POSTGRES_USER=app]
    volumes: ["pgdata:/var/lib/postgresql/data"]
  worker:
    build: ./backend
    command: python worker.py --queue default
    depends_on: [db]
  docs:
    image: nginx
    profiles: [docs]
volumes: { pgdata: {} }
`;

  it('starts dependencies first and gives every service its role', async () => {
    const s = await setupOf({ 'compose.yaml': compose });
    expect(s.services.map((x) => `${x.name}:${x.role}`)).toEqual(['db:database', 'api:api', 'web:web', 'worker:worker']);
  });

  it('keeps literal values and drops what only a shell could fill in', async () => {
    const s = await setupOf({ 'compose.yaml': compose });
    const api = s.services.find((x) => x.name === 'api')!;
    expect(api.environment).toEqual({ DATABASE_URL: 'postgres://app:app@db:5432/app' });
    expect(api.build).toEqual({ context: 'backend', dockerfile: 'backend/Dockerfile.prod', args: { MODE: 'production' } });
    expect(s.services.find((x) => x.name === 'worker')!.command).toEqual(['python', 'worker.py', '--queue', 'default']);
  });

  it('gives a database its protocol port and its named volume as storage', async () => {
    const db = (await setupOf({ 'compose.yaml': compose })).services.find((x) => x.name === 'db')!;
    expect(db.ports).toEqual([5432]);
    expect(db.dataPaths).toEqual(['/var/lib/postgresql/data']);
  });

  it('drops a bind mount inside the repository, saying so, and skips profiled services', async () => {
    const s = await setupOf({ 'compose.yaml': compose });
    expect(s.warnings.join('\n')).toMatch(/not mounting \.\/backend at \/code/);
    expect(s.warnings.join('\n')).toMatch(/Skipping docs/);
    expect(s.services.map((x) => x.name)).not.toContain('docs');
  });

  it('reads an env_file inside the repository and ignores one that is missing', async () => {
    const s = await setupOf({
      'docker-compose.yml': 'services:\n  app:\n    image: node:20\n    ports: [3000]\n    env_file: [.env.docker, .env]\n',
      '.env.docker': 'A=1\nexport B="two words"\nC=${HOME}\n',
    });
    expect(s.services[0]!.environment).toEqual({ A: '1', B: 'two words' });
  });

  it('takes the port from the Dockerfile when compose publishes none', async () => {
    const s = await setupOf({
      'compose.yml': 'services:\n  api:\n    build: .\n',
      Dockerfile: 'FROM node\nEXPOSE 4000\n',
    });
    expect(s.services[0]!.ports).toEqual([4000]);
  });
});

describe('settings the balanced profile refuses', () => {
  const one = (svc: string) => ({ 'compose.yaml': `services:\n  app:\n    image: alpine\n${svc}` });

  it.each([
    ['privileged', '    privileged: true\n', /privileged/],
    ['added capabilities', '    cap_add: [NET_ADMIN]\n', /cap_add/],
    ['devices', '    devices: ["/dev/kvm:/dev/kvm"]\n', /devices/],
    ['host network', '    network_mode: host\n', /network_mode: host/],
    ['host PID namespace', '    pid: host\n', /pid: host/],
    ['host IPC namespace', '    ipc: host\n', /ipc: host/],
    ['another container\'s network', '    network_mode: "container:abc"\n', /container:abc/],
    ['a security profile', '    security_opt: ["seccomp:unconfined"]\n', /security_opt/],
    ['the Docker socket', '    volumes: ["/var/run/docker.sock:/var/run/docker.sock"]\n', /Docker socket/],
    ['a host folder', '    volumes: ["/Users/me/.ssh:/root/.ssh"]\n', /outside the repository/],
    ['a folder above the repository', '    volumes: ["../secrets:/s"]\n', /outside the repository/],
    ['a home-directory path', '    volumes: ["~/.aws:/root/.aws"]\n', /outside the repository/],
    ['an env_file above the repository', '    env_file: ../../.env\n', /env_file/],
    ['kernel parameters', '    sysctls: { net.ipv4.ip_forward: 1 }\n', /sysctls/],
    // Not applied either way, but named rather than ignored (verifier D-4).
    ['the host cgroup namespace', '    cgroup: host\n', /cgroup/],
    ["another container's volumes", '    volumes_from: [db]\n', /volumes_from/],
    ['settings from another file', '    extends: { file: other.yml, service: x }\n', /extends/],
    ['the OOM killer turned off', '    oom_kill_disable: true\n', /oom_kill_disable/],
    ['the process limit lifted', '    pids_limit: -1\n', /pids_limit/],
    ['resource limits', '    ulimits: { nproc: 65535 }\n', /ulimits/],
  ])('refuses %s, naming it', async (_label, svc, reason) => {
    expect(await refusalOf(one(svc))).toMatch(reason);
  });

  it('refuses a build that reaches outside the repository or the sandbox', async () => {
    expect(await refusalOf({ 'compose.yaml': 'services:\n  a:\n    build: ../other\n' })).toMatch(/outside the repository/);
    expect(await refusalOf({ 'compose.yaml': 'services:\n  a:\n    build: { context: ., dockerfile: ../../Dockerfile }\n' })).toMatch(/outside the repository/);
    expect(await refusalOf({ 'compose.yaml': 'services:\n  a:\n    build: https://github.com/x/y.git\n' })).toMatch(/remote context/);
    expect(await refusalOf({ 'compose.yaml': 'services:\n  a:\n    build: { context: ., ssh: [default] }\n' })).toMatch(/ssh/);
    expect(await refusalOf({ 'compose.yaml': 'services:\n  a:\n    build: { context: ., network: host }\n' })).toMatch(/network/);
  });

  it('refuses a dependency cycle and a file that is not YAML', async () => {
    expect(await refusalOf({ 'compose.yaml': 'services:\n  a: { image: x, depends_on: [b] }\n  b: { image: y, depends_on: [a] }\n' })).toMatch(/cycle/);
    expect(await refusalOf({ 'compose.yaml': 'services: [unclosed\n' })).toMatch(/not valid YAML/);
  });

  it('refuses an image reference that is not one', async () => {
    expect(await refusalOf({ 'compose.yaml': 'services:\n  a:\n    image: "alpine; rm -rf /"\n' })).toMatch(/not a valid image/);
    expect(validImageName('ghcr.io/owner/app:1.2.3')).toBe(true);
    expect(validImageName('localhost:5000/app')).toBe(true);
    expect(validImageName('postgres@sha256:' + 'a'.repeat(64))).toBe(true);
    expect(validImageName('--privileged')).toBe(false);
  });

  it('allows what the balanced profile allows: the image\'s user, named volumes, a false flag', async () => {
    const s = await setupOf({ 'compose.yaml': 'services:\n  app:\n    image: alpine\n    user: root\n    privileged: false\n    cap_add: []\n    volumes: [data:/data]\n    ports: [80]\n' });
    expect(s.services[0]!.dataPaths).toEqual(['/data']);
  });
});

describe('what this reader applies, and says it does not (verifier D-10)', () => {
  it('honours entrypoint, fills ${VAR:-default} in image names, and names files it does not apply', async () => {
    const s = await setupOf({
      'compose.yaml': 'services:\n  app:\n    image: "nginx:${TAG:-1.27}"\n    entrypoint: ["/bin/sh", "-c"]\n    command: "nginx -g \'daemon off;\'"\n    ports: [80]\n',
      'compose.override.yaml': 'services: {}\n',
    });
    expect(s.services[0]!.image).toBe('nginx:1.27');
    expect(s.services[0]!.entrypoint).toEqual(['/bin/sh', '-c']);
    expect(s.services[0]!.command).toEqual(['nginx', '-g', 'daemon off;']);
    expect(s.warnings.join('\n')).toMatch(/compose\.override\.yaml is not applied/);
  });

  it('refuses `include` of other compose files', async () => {
    expect(await refusalOf({ 'compose.yaml': 'include: [other.yaml]\nservices:\n  a: { image: alpine }\n' })).toMatch(/include/);
  });

  it('says a .dockerignore is not applied', async () => {
    const s = await setupOf({ Dockerfile: 'FROM alpine\nEXPOSE 80\n', '.dockerignore': 'node_modules\n' });
    expect(s.warnings.join('\n')).toMatch(/\.dockerignore is not applied/);
  });
});

describe('ports', () => {
  it('reads every compose spelling as the container side', () => {
    expect(readPorts(['8000', '3000:80', '127.0.0.1:8080:8081/tcp', { target: 9000, published: 1 }, 5000, '53:53/udp', '7000-7002:7000-7002'])).toEqual([8000, 80, 8081, 9000, 5000, 7000]);
  });
});
