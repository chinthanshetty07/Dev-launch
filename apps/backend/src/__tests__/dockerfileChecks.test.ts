import { describe, it, expect } from 'vitest';
import { dockerfileFetches, dockerfileProblems, registryProblem, privateAddress } from '../services/docker/DockerfileChecks.js';
import { shellWords } from '../services/docker/RepoDockerSetup.js';

/**
 * Verifier D-1: the Docker daemon itself makes some of a build's fetches — `ADD <url>`,
 * the images `FROM` and `COPY --from` name — on the VM's own network, outside the egress
 * rules a `RUN` step meets. Each is judged before anything is built.
 */
// Like real DNS: an address resolves to itself, and a name nobody listed to a public
// address — so each refusal below has to come from its own rule, not from a failed lookup.
const dns = (table: Record<string, string[]>) => async (h: string) => {
  if (table[h]) return table[h]!;
  if (/^[\d.]+$/.test(h) || h.includes(':')) return [h];
  return ['93.184.216.34'];
};
const publicDns = dns({ 'ghcr.io': ['140.82.112.33'], 'registry.example.com': ['93.184.216.34'], 'evil.example.com': ['192.168.1.1'] });

describe('what a Dockerfile makes the daemon fetch', () => {
  it('finds base images, COPY --from images and ADD URLs — not build stages', () => {
    const f = dockerfileFetches([
      'ARG BASE=node:20',
      'FROM --platform=linux/amd64 ${BASE} AS build',
      'COPY --from=build /a /b',
      'COPY --from=ghcr.io/owner/tool:1 /bin/tool /bin/tool',
      'ADD https://example.com/file.tgz /tmp/',
      'ADD \\',
      '    http://169.254.169.254/latest/meta-data/ /m',
      'FROM scratch',
    ].join('\n'));
    expect(f.images).toEqual(['node:20', 'ghcr.io/owner/tool:1']);
    expect(f.urls).toEqual(['https://example.com/file.tgz', 'http://169.254.169.254/latest/meta-data/']);
  });

  it('applies build args, and says when an image depends on a variable with no value', () => {
    expect(dockerfileFetches('ARG V\nFROM python:${V}', { V: '3.12' }).images).toEqual(['python:3.12']);
    expect(dockerfileFetches('FROM ${UNSET_BASE}').unresolved).toEqual(['${UNSET_BASE}']);
  });
});

describe('what the daemon may fetch', () => {
  it('refuses ADD from any URL, naming it, and suggests RUN', async () => {
    const p = await dockerfileProblems('FROM alpine\nADD http://192.168.1.1/ /leak\n', {}, publicDns);
    expect(p.join('\n')).toMatch(/ADD http:\/\/192\.168\.1\.1\/.*download it in a RUN step instead/);
  });

  it('refuses registries on this machine, the VM or the local network', async () => {
    for (const image of ['localhost:5000/app', '192.168.1.10:5000/x', '10.0.0.5/x', '192.168.5.2:5000/y', '140.82.112.33:5000/x', 'registry.local/x', 'registry.internal/x', 'myregistry:5000/x', 'evil.example.com/x']) {
      expect(await registryProblem(image, publicDns), image).not.toBeNull();
    }
  });

  it('allows Docker Hub and public registries', async () => {
    for (const image of ['node:20', 'library/postgres:16', 'bitnami/redis', 'ghcr.io/owner/app:1', 'registry.example.com/x/y']) {
      expect(await registryProblem(image, publicDns), image).toBeNull();
    }
    expect(await dockerfileProblems('FROM node:20\nRUN echo ok\n', {}, publicDns)).toEqual([]);
  });

  it('knows a private address from a public one', () => {
    for (const ip of ['10.1.2.3', '172.20.0.1', '192.168.5.2', '127.0.0.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1']) expect(privateAddress(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '140.82.112.33', '172.32.0.1']) expect(privateAddress(ip), ip).toBe(false);
  });
});

describe('a compose command string (verifier D-9)', () => {
  it('is split as a shell splits words, quotes kept together, nothing expanded', () => {
    expect(shellWords('sh -c "npm run migrate && npm start"')).toEqual(['sh', '-c', 'npm run migrate && npm start']);
    expect(shellWords("python -m http.server --bind '0.0.0.0' 8000")).toEqual(['python', '-m', 'http.server', '--bind', '0.0.0.0', '8000']);
    expect(shellWords('echo a\\ b "$HOME"')).toEqual(['echo', 'a b', '$HOME']);
  });
});
