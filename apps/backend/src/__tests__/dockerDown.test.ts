import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FailureCode } from '@devlaunch/shared';
import { DockerManager } from '../services/docker/DockerManager.js';
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

  it('still says to build the image when Docker answers that it does not have it', async () => {
    const socket = join(mkdtempSync(join(tmpdir(), 'devlaunch-docker-')), 'docker.sock');
    server = createServer((_req, res) => {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'No such image: devlaunch/node:20' }));
    });
    await new Promise<void>((r) => server!.listen(socket, r));
    await expect(new DockerManager(socket).ensureImage('devlaunch/node:20')).rejects.toThrow(
      /Runner image "devlaunch\/node:20" is not built/,
    );
  });
});
