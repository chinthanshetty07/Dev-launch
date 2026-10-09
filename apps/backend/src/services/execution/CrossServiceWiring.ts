import type { ServiceRunPlan } from '@devlaunch/shared';

/**
 * Tell each service where its siblings actually are.
 *
 * Everything else in a project talks over the container network, where a name is enough.
 * The browser is the exception and the reason this exists: a page fetching
 * `http://localhost:5001` is resolved by the *user's machine*, so no alias, no network
 * and no amount of correct orchestration can satisfy it. Only the published host URL can.
 *
 * Two variables decide whether a working stack looks broken:
 *
 * - the frontend's API base, or every request the page makes is refused;
 * - the API's allowed origin, or every request the page makes is refused *by CORS*,
 *   which looks identical from the browser and is not.
 *
 * Both are read from what each service declares, for the same reason the database URL
 * is: a frontend reading `VITE_API_URL` ignores `REACT_APP_API_URL`.
 */

/** Variables a browser-facing service reads its API base URL from, most specific first. */
const API_BASE_KEYS = [
  'VITE_API_URL',
  'VITE_API_BASE_URL',
  'VITE_BACKEND_URL',
  'REACT_APP_API_URL',
  'REACT_APP_API_BASE_URL',
  // RishiBakshii/mern-ecommerce's frontend reads this one.
  'REACT_APP_BASE_URL',
  'NEXT_PUBLIC_API_URL',
  'NEXT_PUBLIC_API_BASE_URL',
  'VUE_APP_API_URL',
  'NUXT_PUBLIC_API_BASE',
  'PUBLIC_API_URL',
  'API_URL',
  'API_BASE_URL',
  'BACKEND_URL',
];

/** Variables an API reads its permitted browser origin from. */
const ORIGIN_KEYS = [
  'CORS_ORIGIN',
  'CORS_ORIGINS',
  'ALLOWED_ORIGINS',
  'ALLOWED_ORIGIN',
  'CLIENT_URL',
  'CLIENT_ORIGIN',
  'FRONTEND_URL',
  // Read by a real repository whose CORS was refused for want of this one name. The
  // list is a list because there is no convention here, only what each author chose —
  // and a name absent from it is indistinguishable, from the browser, from an API that
  // is down. Every addition should come from a repository that reads it.
  'FRONTEND_ORIGIN',
  'APP_URL',
  'APP_ORIGIN',
  'WEB_ORIGIN',
  // Bare, as RishiBakshii/mern-ecommerce's backend reads it: `cors({ origin: process.env.ORIGIN })`.
  'ORIGIN',
  // fastapi/full-stack-fastapi-template: CORS allows FRONTEND_HOST, read through pydantic settings.
  'FRONTEND_HOST',
];

export interface WiringInput {
  /** Public URL each service will be reachable at, keyed by service name. */
  urls: Record<string, string>;
  /**
   * Container-network URL each service answers to, keyed by service name.
   *
   * Optional; absent means "assume the browser", which is what this did before the
   * distinction existed. See `resolvedByBrowser`.
   */
  internalUrls?: Record<string, string>;
  /** Variables each service declares for itself, keyed by service name. */
  envKeys: Record<string, string[]>;
}

/**
 * Prefixes a bundler inlines into code the browser runs.
 *
 * The whole question is *who resolves the address*, and these prefixes answer it. A
 * `VITE_`-prefixed variable is substituted into the bundle at build time and read on the
 * user's machine, where only a published host port exists. Anything else a web service
 * reads is read by a process inside its own container — a dev server's proxy target, a
 * server-rendered fetch — where the published port is nothing and a container alias is
 * everything.
 *
 * Getting this backwards does not fail loudly. It produces a frontend that serves a page
 * and cannot reach its API, which looks exactly like getting it right, and exactly like
 * the API being down.
 */
const BROWSER_PREFIXES = ['VITE_', 'REACT_APP_', 'NEXT_PUBLIC_', 'VUE_APP_', 'PUBLIC_', 'NUXT_PUBLIC_'];

/** Whether this variable's value will be resolved on the user's machine. */
export function resolvedByBrowser(key: string): boolean {
  return BROWSER_PREFIXES.some((p) => key.startsWith(p));
}

export interface WiredVar {
  key: string;
  value: string;
  /** Why it was set, for the log line that explains what DevLaunch did. */
  reason: string;
}

/**
 * Variables to add to one service so it can find the others.
 *
 * Only keys the service declares are set. Guessing is tempting and wrong here: an
 * invented `CORS_ORIGIN` on a service that reads `ALLOWED_ORIGINS` achieves nothing,
 * and an invented one on a service that reads neither can *narrow* a permissive default
 * into a broken one.
 */
export function wireService(
  plan: ServiceRunPlan,
  services: ServiceRunPlan[],
  input: WiringInput,
): WiredVar[] {
  const declared = new Set(input.envKeys[plan.name] ?? []);
  const alreadySet = new Set(
    plan.environmentVariables.filter((v) => v.value !== null).map((v) => v.key),
  );
  const out: WiredVar[] = [];

  const add = (key: string, value: string, reason: string): void => {
    // A value the repository already supplies is a decision; overruling it is not ours.
    if (alreadySet.has(key) || out.some((v) => v.key === key)) return;
    out.push({ key, value, reason });
  };

  if (plan.role === 'web') {
    const api = services.find((s) => s.role === 'api' && input.urls[s.name]);
    const apiUrl = api ? input.urls[api.name] : undefined;
    if (apiUrl) {
      const apiInternal = api ? input.internalUrls?.[api.name] : undefined;
      for (const key of API_BASE_KEYS) {
        if (!declared.has(key)) continue;
        // Who resolves this address decides which one it is. A bundler-prefixed name is
        // read on the user's machine and needs the published port; anything else a
        // frontend reads — a dev server's proxy target, most often — is read by a
        // process inside this container, where the published port is nothing at all.
        const browser = resolvedByBrowser(key) || !apiInternal;
        add(
          key,
          stripTrailingSlash(browser ? apiUrl : apiInternal!),
          browser
            ? `${api!.name} is published here`
            : `${api!.name} answers to this on the container network, and this value is ` +
              'read inside the container rather than by the browser',
        );
      }
    }
  }

  if (plan.role === 'api') {
    const web = services.find((s) => s.role === 'web' && input.urls[s.name]);
    const webUrl = web ? input.urls[web.name] : undefined;
    if (webUrl) {
      for (const key of ORIGIN_KEYS) {
        if (declared.has(key)) {
          add(key, stripTrailingSlash(webUrl), `${web!.name} is served from here`);
        }
      }
    }
  }

  return out;
}

/**
 * The host port an API should be published on, given what its siblings hardcode.
 *
 * A repository with no configuration variable to read leaves exactly one way to satisfy
 * it: publish where the page already looks. `http://localhost:5001` in a frontend's
 * source is not a preference, it is the only address that will ever be requested.
 */
export function preferredApiHostPort(
  api: ServiceRunPlan,
  services: ServiceRunPlan[],
  callsOrigins: Record<string, string[]>,
): number | undefined {
  if (api.role !== 'api') return undefined;

  const ports = services
    .filter((s) => s.role === 'web')
    .flatMap((s) => callsOrigins[s.name] ?? [])
    .map((origin) => Number(new URL(origin).port))
    .filter((port) => Number.isInteger(port) && port > 0);

  return ports[0];
}

/**
 * Variables DevLaunch will fill in for this service, so nobody is asked for them.
 *
 * A gate that asks for `CORS_ORIGIN` is asking the user to guess a port DevLaunch has
 * not chosen yet, and a value they supply would be overridden or — worse — respected and
 * wrong. Knowing the *names* needs no URLs, which is why this can run before anything
 * starts.
 */
export function wirableKeys(role: ServiceRunPlan['role'], declared: readonly string[]): string[] {
  const candidates = role === 'web' ? API_BASE_KEYS : role === 'api' ? ORIGIN_KEYS : [];
  return candidates.filter((key) => declared.includes(key));
}

const stripTrailingSlash = (url: string): string => url.replace(/\/+$/, '');

/**
 * A literal in the source that the browser will resolve, and that no longer resolves.
 *
 * Named for what a person experiences rather than for the mechanism: from the browser,
 * an API refusing an origin and an API that is down are the same blank failure.
 */
export interface BrowserWiringProblem {
  /** The service whose source carries the literal. */
  service: string;
  /** Where it is, relative to that service's directory, when we know. */
  file?: string;
  /** The address written in the source. */
  expected: string;
  /** The address the sibling actually got. */
  actual: string;
  /** What breaks, in the terms of the person looking at a blank page. */
  problem: string;
}

/**
 * Why a project that reached READY will still not work in a browser.
 *
 * READY means every container answered an HTTP request. For a frontend calling an API
 * that is the weakest interesting claim: the page loads, the API is up, and every
 * request between them is refused — because the port in the page's source, or in the
 * API's CORS allowlist, was written when both were on their default ports and neither
 * is any more.
 *
 * `wireService` already fixes this wherever the repository reads a variable, and that
 * covers the repositories that were written to be deployed. What is left is the ones
 * that were written to be run on a laptop, where a literal was always going to be true.
 * For those there is nothing to set, so the only honest thing is to say so — with the
 * file, the address it names and the address that would work.
 *
 * Deliberately pure and deliberately post-hoc: it compares what was *written* against
 * what was actually *published*, and neither is knowable until the run exists.
 */
export function browserWiringProblems(input: {
  services: ServiceRunPlan[];
  /** Published URL per service name, as a person would open it. */
  urls: Record<string, string>;
  /** Origins each API's source will accept, per service name. */
  acceptsOrigins: Record<string, { origin: string; file: string }[]>;
  /** Origins each web service's source calls, per service name. */
  callsOrigins: Record<string, string[]>;
  /** Keys `wireService` actually set, per service name. */
  wired: Record<string, string[]>;
}): BrowserWiringProblem[] {
  const out: BrowserWiringProblem[] = [];
  const web = input.services.find((s) => s.role === 'web');
  const api = input.services.find((s) => s.role === 'api');
  if (!web || !api) return out;

  const webOrigin = originOf(input.urls[web.name]);
  const apiOrigin = originOf(input.urls[api.name]);

  // The API's allowlist. Skipped when a variable was wired: the repository asked to be
  // told where its frontend is, and it was told — whatever else its source also says.
  const wiredOrigin = (input.wired[api.name] ?? []).some((k) => ORIGIN_KEYS.includes(k));
  const accepts = input.acceptsOrigins[api.name] ?? [];
  if (webOrigin && !wiredOrigin && accepts.length > 0) {
    if (!accepts.some((a) => originOf(a.origin) === webOrigin)) {
      const first = accepts[0]!;
      out.push({
        service: api.name,
        file: first.file,
        expected: first.origin,
        actual: webOrigin,
        problem:
          `${api.name} accepts browser requests only from ${accepts.map((a) => a.origin).join(', ')}, ` +
          `and ${web.name} is served from ${webOrigin}. Every request the page makes will be ` +
          'refused by CORS, which in the browser looks the same as the API being down.',
      });
    }
  }

  // The page's own API base, for the same reason in the other direction.
  const wiredBase = (input.wired[web.name] ?? []).some((k) => API_BASE_KEYS.includes(k));
  const calls = input.callsOrigins[web.name] ?? [];
  if (apiOrigin && !wiredBase && calls.length > 0) {
    if (!calls.some((c) => originOf(c) === apiOrigin)) {
      out.push({
        service: web.name,
        expected: calls[0]!,
        actual: apiOrigin,
        problem:
          `${web.name} calls ${calls.join(', ')} from the browser, and ${api.name} is published ` +
          `at ${apiOrigin}. Nothing is serving the address the page asks for.`,
      });
    }
  }

  return out;
}

/** scheme://host:port, discarding the path a health check contributed. */
function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}
