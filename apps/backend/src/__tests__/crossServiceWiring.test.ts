import { describe, it, expect } from 'vitest';
import { RunPlanSchema, type ServiceRunPlan } from '@devlaunch/shared';
import { preferredApiHostPort, wireService } from '../services/execution/CrossServiceWiring.js';
import { choosePort, isPortFree } from '../services/ports/HostPorts.js';
import { createServer } from 'node:net';

const service = (over: Partial<ServiceRunPlan> & Pick<ServiceRunPlan, 'name' | 'role'>): ServiceRunPlan => ({
  ...RunPlanSchema.parse({
    runtime: { language: 'node', version: '20' },
    packageManager: 'npm',
    installCommand: null,
    buildCommand: null,
    startCommand: 'npm run dev',
    workingDirectory: over.name,
    expectedPort: 3000,
    planSource: 'rule-based',
  }),
  ...over,
});

const web = service({ name: 'frontend', role: 'web' });
const api = service({ name: 'backend', role: 'api', expectedPort: 5000 });
const urls = { frontend: 'http://localhost:5173/', backend: 'http://localhost:5001/' };

describe('cross-service wiring', () => {
  it('tells a frontend where its API is published, under the name it reads', () => {
    // The browser resolves this URL, not Docker: no alias, network or correct
    // orchestration can satisfy a page fetching a host address.
    const wired = wireService(web, [web, api], {
      urls,
      envKeys: { frontend: ['VITE_API_URL'] },
    });
    expect(wired).toEqual([
      { key: 'VITE_API_URL', value: 'http://localhost:5001', reason: 'backend is published here' },
    ]);
  });

  it('tells an API which origin the browser will call it from', () => {
    // Without it, a correctly published API refuses every request with a CORS error,
    // which from the browser looks identical to the API being down.
    const wired = wireService(api, [web, api], {
      urls,
      envKeys: { backend: ['CORS_ORIGIN'] },
    });
    expect(wired).toEqual([
      { key: 'CORS_ORIGIN', value: 'http://localhost:5173', reason: 'frontend is served from here' },
    ]);
  });

  it('sets only variables the service actually declares', () => {
    // Inventing one is worse than doing nothing: CORS_ORIGIN on a service that reads
    // ALLOWED_ORIGINS achieves nothing, and on one that reads neither it can narrow a
    // permissive default into a broken one.
    expect(wireService(api, [web, api], { urls, envKeys: { backend: ['ALLOWED_ORIGINS'] } })).toEqual([
      { key: 'ALLOWED_ORIGINS', value: 'http://localhost:5173', reason: 'frontend is served from here' },
    ]);
    expect(wireService(api, [web, api], { urls, envKeys: { backend: ['UNRELATED'] } })).toEqual([]);
  });

  it('never overrules a value the repository already supplies', () => {
    const configured: ServiceRunPlan = {
      ...web,
      environmentVariables: [{ key: 'VITE_API_URL', value: 'http://my-own-api', required: false }],
    };
    expect(wireService(configured, [configured, api], { urls, envKeys: { frontend: ['VITE_API_URL'] } })).toEqual([]);
  });

  it('publishes an API where the frontend hardcodes it', () => {
    // A repository with no configuration variable leaves one way to satisfy it: publish
    // where the page already looks, because that is the only address it will request.
    expect(
      preferredApiHostPort(api, [web, api], { frontend: ['http://localhost:5001'] }),
    ).toBe(5001);
  });

  it('has no preference when nothing hardcodes an address', () => {
    expect(preferredApiHostPort(api, [web, api], {})).toBeUndefined();
    // A web service is never published on its sibling's hardcoded API port.
    expect(preferredApiHostPort(web, [web, api], { frontend: ['http://localhost:5001'] })).toBeUndefined();
  });
});

describe('host port selection', () => {
  it('treats a port held on IPv6 as taken', async () => {
    // `localhost` resolves to ::1 first, so a port free on IPv4 and taken on IPv6 is not
    // free: Docker publishes on IPv4 and succeeds, and the browser talks to whatever
    // already held the IPv6 address. Measured on a real machine, where a dev server on
    // ::1:5173 left 127.0.0.1:5173 bindable.
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '::1', () => resolve());
    });
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    try {
      expect(await isPortFree(port), 'a port held on ::1 is not free').toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('prefers the wanted port and says so when it cannot have it', async () => {
    const taken = new Set<number>();
    const first = await choosePort([0], taken);
    expect(first.substituted).toBe(false);

    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    const busy = typeof address === 'object' && address ? address.port : 0;

    try {
      const choice = await choosePort([busy], new Set());
      expect(choice.port).not.toBe(busy);
      // The caller has to know: a URL built from the preferred port would be wrong.
      expect(choice.substituted).toBe(true);
      expect(choice.preferred).toBe(busy);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('does not hand the same port to two services', async () => {
    // isPortFree cannot see a port promised a moment ago but not yet bound, so two
    // services asking for 3000 would otherwise both be told yes.
    const taken = new Set<number>();
    const a = await choosePort([3000], taken);
    const b = await choosePort([3000], taken);
    expect(b.port).not.toBe(a.port);
  });
});
