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
  'CLIENT_URL',
  'FRONTEND_URL',
  'APP_URL',
  'WEB_ORIGIN',
];

export interface WiringInput {
  /** Public URL each service will be reachable at, keyed by service name. */
  urls: Record<string, string>;
  /** Variables each service declares for itself, keyed by service name. */
  envKeys: Record<string, string[]>;
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
      for (const key of API_BASE_KEYS) {
        if (declared.has(key)) add(key, stripTrailingSlash(apiUrl), `${api!.name} is published here`);
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
