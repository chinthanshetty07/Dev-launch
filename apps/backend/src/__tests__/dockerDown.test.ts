import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FailureCode } from '@devlaunch/shared';
import { DockerManager, runnerRecipe } from '../services/docker/DockerManager.js';
import { failureOf } from '../services/session/SessionManager.js';

/**
 * Docker stopped is not an image missing. With the Colima VM stopped, a run ended on
 * `Runner image "devlaunch/node:20" is not built. Run ./scripts/build-runner-images.sh` —
 * the images were there all along, and rebuilding them could not have helped.
 */
describe('a missing runner image, and a Docker that is not running', () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  it('says Docker is not answering, and how to start it, when nothing is on the socket', async () => {
    const socket = join(mkdtempSync(join(tmpdir(), 'devlaunch-nodocker-')), 'docker.sock');
    const err = await new DockerManager(socket).ensureImage('devlaunch/node:20').catch((e: unknown) => e);
    expect(String((err as Error).message)).not.toMatch(/is not built/);
    const failure = failureOf(err);
    expect(failure.code).toBe(FailureCode.UNKNOWN_RUNTIME_ERROR);
    expect(failure.remedy).toMatch(/Docker stopped answering.*Colima/);
  });

  // Changed fact: a missing approved runner image is now built on the spot (see below), so
  // "not built" is said only for one DevLaunch has no recipe for.
  it('still says "not built" when Docker has no such image and DevLaunch has no recipe for it', async () => {
    const socket = join(mkdtempSync(join(tmpdir(), 'devlaunch-docker-')), 'docker.sock');
    server = createServer((_req, res) => {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'No such image' }));
    });
    await new Promise<void>((r) => server!.listen(socket, r));
    await expect(new DockerManager(socket).ensureImage('devlaunch/node:18')).rejects.toThrow(
      /Runner image "devlaunch\/node:18" is not built/,
    );
  });
});

/**
 * A runner image added after a person installed DevLaunch (Python 3.14, for
 * `fastapi/full-stack-fastapi-template`) is built the first time a project needs it, from
 * the recipe in this repository, instead of the run stopping on "not built".
 */
describe('building a missing runner image', () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  it('maps only approved runner images to their recipe', () => {
    expect(runnerRecipe('devlaunch/python:3.14')).toEqual({ dockerfile: 'python.Dockerfile', buildargs: { PYTHON_VERSION: '3.14' } });
    expect(runnerRecipe('devlaunch/node:22')).toEqual({ dockerfile: 'node.Dockerfile', buildargs: { NODE_VERSION: '22' } });
    expect(runnerRecipe('devlaunch/node:18')).toBeNull();
    expect(runnerRecipe('devlaunch/guard')).toBeNull();
    expect(runnerRecipe('python:3.14')).toBeNull();
  });

  it('builds it once, from docker/runner, saying so in the log, when two runs need it together', async () => {
    const socket = join(mkdtempSync(join(tmpdir(), 'devlaunch-build-')), 'docker.sock');
    let built = false;
    const builds: URLSearchParams[] = [];
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://docker');
      if (req.method === 'POST' && url.pathname.endsWith('/build')) {
        builds.push(url.searchParams);
        req.resume();
        req.on('end', () => {
          setTimeout(() => {
            built = true;
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(['{"stream":"Step 1/5 : FROM python:3.14-slim\\n"}', '{"stream":" ---> abc\\n"}', '{"stream":"Successfully built abc\\n"}', ''].join('\r\n'));
          }, 30);
        });
        return;
      }
      res.writeHead(built ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(built ? { Id: 'sha256:abc' } : { message: 'No such image' }));
    });
    await new Promise<void>((r) => server!.listen(socket, r));

    const said: string[] = [];
    const docker = new DockerManager(socket);
    await Promise.all([
      docker.ensureImage('devlaunch/python:3.14', (l) => said.push(l)),
      docker.ensureImage('devlaunch/python:3.14'),
    ]);
    expect(builds).toHaveLength(1);
    expect(builds[0]!.get('t')).toBe('devlaunch/python:3.14');
    expect(builds[0]!.get('dockerfile')).toBe('python.Dockerfile');
    expect(JSON.parse(builds[0]!.get('buildargs')!)).toEqual({ PYTHON_VERSION: '3.14' });
    expect(said[0]).toMatch(/devlaunch\/python:3\.14 is not on this machine yet, so DevLaunch is building it now/);
    expect(said).toContain('Step 1/5 : FROM python:3.14-slim');
    expect(said.at(-1)).toBe('Built devlaunch/python:3.14.');
  });

  it('fails the run with a reason when the build fails', async () => {
    const socket = join(mkdtempSync(join(tmpdir(), 'devlaunch-build-')), 'docker.sock');
    server = createServer((req, res) => {
      if (req.method === 'POST') {
        req.resume();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"error":"no space left on device","errorDetail":{"message":"no space left on device"}}\r\n');
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'No such image' }));
    });
    await new Promise<void>((r) => server!.listen(socket, r));
    await expect(new DockerManager(socket).ensureImage('devlaunch/python:3.14')).rejects.toThrow(
      /Building runner image "devlaunch\/python:3\.14" failed: no space left on device/,
    );
  });
});
