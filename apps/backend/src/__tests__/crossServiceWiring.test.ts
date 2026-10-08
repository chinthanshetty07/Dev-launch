import { describe, it, expect } from 'vitest';
import { RunPlanSchema, type ServiceRunPlan } from '@devlaunch/shared';
import {
  browserWiringProblems,
  preferredApiHostPort,
  resolvedByBrowser,
  wireService,
} from '../services/execution/CrossServiceWiring.js';
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
  it('wires the bare names RishiBakshii/mern-ecommerce reads: REACT_APP_BASE_URL and ORIGIN', () => {
    expect(wireService(web, [web, api], { urls, envKeys: { frontend: ['REACT_APP_BASE_URL'] } })).toEqual([
      { key: 'REACT_APP_BASE_URL', value: 'http://localhost:5001', reason: 'backend is published here' },
    ]);
    expect(wireService(api, [web, api], { urls, envKeys: { backend: ['ORIGIN'] } })).toEqual([
      { key: 'ORIGIN', value: 'http://localhost:5173', reason: 'frontend is served from here' },
    ]);
  });

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

  it('treats a port held on the IPv4 wildcard as taken', async () => {
    // How Docker publishes, and how most servers bind. A loopback-only probe walks
    // straight past it: Node sets SO_REUSEADDR, so binding 127.0.0.1 succeeds alongside
    // a wildcard holder. Publishing onto it anyway fails the whole project with an
    // opaque `failed to set up container networking` from the daemon.
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', () => resolve()));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    try {
      expect(await isPortFree(port), 'a port held on 0.0.0.0 is not free').toBe(false);
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

/**
 * READY means every container answered an HTTP request. For a frontend calling an API
 * that is the weakest interesting claim, and two real repositories proved it: both
 * reached READY in under ten seconds, both served a page, and in both every request the
 * page made was refused. `ecom_app` hardcodes `origin: 'http://localhost:5173'` in its
 * server; `FocusPaws` hardcodes a list of two. Nothing said a word about either.
 */
describe('why a READY project still will not work in a browser', () => {
  const webS = service({ name: 'client', role: 'web' });
  const apiS = service({ name: 'server', role: 'api', expectedPort: 5000 });
  const live = { client: 'http://localhost:57206/', server: 'http://localhost:57205/api/cart/' };

  it('names the CORS allowlist that no longer includes the frontend', () => {
    const [problem, ...rest] = browserWiringProblems({
      services: [webS, apiS],
      urls: live,
      acceptsOrigins: { server: [{ origin: 'http://localhost:5173', file: 'index.js' }] },
      callsOrigins: {},
      wired: {},
    });

    expect(rest).toEqual([]);
    expect(problem).toMatchObject({ service: 'server', file: 'index.js' });
    // The two addresses are the whole point: one is in the source, one is real.
    expect(problem!.expected).toBe('http://localhost:5173');
    expect(problem!.actual).toBe('http://localhost:57206');
    expect(problem!.problem).toMatch(/refused by CORS/);
  });

  it('says nothing when the repository reads a variable and was told', () => {
    // `wireService` already handled it. A warning here would be telling somebody to fix
    // a line that is no longer load-bearing, which is worse than silence.
    expect(
      browserWiringProblems({
        services: [webS, apiS],
        urls: live,
        acceptsOrigins: { server: [{ origin: 'http://localhost:5173', file: 'index.js' }] },
        callsOrigins: {},
        wired: { server: ['CORS_ORIGIN'] },
      }),
    ).toEqual([]);
  });

  it('says nothing when the hardcoded origin happens to be right', () => {
    // The common case worth protecting: `preferredApiHostPort` publishes an API on the
    // port its frontend names, so a repository whose literals are satisfied is silent.
    expect(
      browserWiringProblems({
        services: [webS, apiS],
        urls: { client: 'http://localhost:5173/', server: 'http://localhost:4000/' },
        // Written with a trailing slash, as authors do. Comparing the strings would
        // call this correct pairing broken and send somebody to edit a working line.
        acceptsOrigins: { server: [{ origin: 'http://localhost:5173/', file: 'index.js' }] },
        callsOrigins: { client: ['http://localhost:4000/api'] },
        wired: {},
      }),
    ).toEqual([]);
  });

  it('names a page calling an address nothing is serving', () => {
    // With a path, because that is the shape a real one has —
    // `VITE_API_URL || 'http://localhost:5000/api'` — and because what is being compared
    // is where the request goes, not how the string was written. A comparison that
    // matched literally would report this correct pairing as broken and vice versa.
    const problems = browserWiringProblems({
      services: [webS, apiS],
      urls: live,
      acceptsOrigins: {},
      callsOrigins: { client: ['http://localhost:5000/api'] },
      wired: {},
    });

    expect(problems).toHaveLength(1);
    expect(problems[0]!.service).toBe('client');
    expect(problems[0]!.problem).toMatch(/Nothing is serving the address the page asks for/);
  });

  it('has nothing to say about a project with no browser in it', () => {
    // Two APIs talk over the container network, where an alias is enough and none of
    // this applies.
    expect(
      browserWiringProblems({
        services: [apiS, service({ name: 'worker', role: 'worker' })],
        urls: live,
        acceptsOrigins: { server: [{ origin: 'http://localhost:5173', file: 'index.js' }] },
        callsOrigins: {},
        wired: {},
      }),
    ).toEqual([]);
  });
});

describe('the names an API reads its allowed origin from', () => {
  it('sets FRONTEND_ORIGIN, which a real repository reads and nothing set', () => {
    // FocusPaws' server reads FRONTEND_ORIGIN. It was absent from the table, so its
    // CORS was left at a hardcoded default and the page it served could not call it.
    // There is no convention here — only what each author chose — so this list grows
    // one repository at a time, and each entry should be able to name its own.
    const wired = wireService(service({ name: 'server', role: 'api' }), [
      service({ name: 'client', role: 'web' }),
      service({ name: 'server', role: 'api' }),
    ], {
      urls: { client: 'http://localhost:57217/', server: 'http://localhost:4000/' },
      envKeys: { server: ['PORT', 'FRONTEND_ORIGIN'] },
    });

    expect(wired.map((v) => [v.key, v.value])).toEqual([
      ['FRONTEND_ORIGIN', 'http://localhost:57217'],
    ]);
  });
});

/**
 * Who resolves the address.
 *
 * FocusPaws' Vite config proxies `/api` to `process.env.API_URL || 'http://127.0.0.1:4000'`.
 * That variable is read by the dev server, inside the frontend's own container, where a
 * published host port does not exist — so handing it the URL a person would type produces
 * a page that loads and an API it cannot reach. Which is the same symptom as handing it
 * nothing, and the same symptom as the API being down.
 */
describe('a variable read inside the container, not by the browser', () => {
  const webS = service({ name: 'client', role: 'web' });
  const apiS = service({ name: 'server', role: 'api', expectedPort: 4000 });
  const both = [webS, apiS];
  const input = {
    urls: { client: 'http://localhost:59471/', server: 'http://localhost:4000/' },
    internalUrls: { server: 'http://server:4000' },
  };

  it('gives a dev-server proxy the container address', () => {
    const wired = wireService(webS, both, { ...input, envKeys: { client: ['API_URL'] } });
    expect(wired.map((v) => [v.key, v.value])).toEqual([['API_URL', 'http://server:4000']]);
    expect(wired[0]!.reason).toMatch(/container network/);
  });

  it('gives the browser the published address, for a key the bundler inlines', () => {
    // The same service, the same API, a different name — and the opposite answer,
    // because `VITE_` is substituted into the bundle and read on the user's machine.
    const wired = wireService(webS, both, { ...input, envKeys: { client: ['VITE_API_URL'] } });
    expect(wired.map((v) => [v.key, v.value])).toEqual([
      ['VITE_API_URL', 'http://localhost:4000'],
    ]);
  });

  it('falls back to the published address when no container address is known', () => {
    // Which is what this did before the distinction existed, and is the safer of the
    // two guesses: a host URL is at least reachable from somewhere.
    const wired = wireService(webS, both, {
      urls: input.urls,
      envKeys: { client: ['API_URL'] },
    });
    expect(wired.map((v) => v.value)).toEqual(['http://localhost:4000']);
  });

  it('classifies by prefix, not by a list of names', () => {
    expect(resolvedByBrowser('VITE_ANYTHING_AT_ALL')).toBe(true);
    expect(resolvedByBrowser('NEXT_PUBLIC_API_URL')).toBe(true);
    // A CORS origin is read by the API's own process; the prefix question never arises
    // for it, and answering "browser" would be right for the wrong reason.
    expect(resolvedByBrowser('CORS_ORIGIN')).toBe(false);
    expect(resolvedByBrowser('API_URL')).toBe(false);
  });
});
