import type { NextFunction, Request, Response } from 'express';

/**
 * Who may talk to DevLaunch: this machine, by name.
 *
 * DevLaunch has no login and listens on loopback, which keeps the network out but not a
 * browser. A page on `evil.example` whose DNS answer flips to 127.0.0.1 becomes
 * same-origin with `http://evil.example:3939`, and could launch any repository, read
 * logs and plan values, and stop runs (audit A-10). Its requests carry its own name in
 * `Host`, which is what this checks; a cross-site form or fetch carries its own `Origin`.
 */

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** The name part of a `Host` header or an origin's host: `localhost:3939` → `localhost`. */
function hostName(hostport: string): string {
  const h = hostport.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.split(':')[0]!;
}

export function allowedHosts(extra: readonly string[] = []): Set<string> {
  return new Set([...LOOPBACK_NAMES, ...extra.map((h) => hostName(h)).filter(Boolean)]);
}

/** A request's `Host` names this machine (or a host the operator allowed). */
export function hostAllowed(host: string | undefined, allowed: ReadonlySet<string>): boolean {
  if (!host) return false;
  return allowed.has(hostName(host));
}

/**
 * A request's `Origin`, when it has one, is a page served by this machine. Absent is
 * fine: curl, the CLI and same-origin GETs send none.
 */
export function originAllowed(origin: string | undefined, allowed: ReadonlySet<string>): boolean {
  if (origin === undefined || origin === '') return true;
  try {
    const u = new URL(origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') && allowed.has(hostName(u.host));
  } catch {
    return false;
  }
}

/**
 * What a browser says about where a request came from (`Sec-Fetch-Site`, `Sec-Fetch-Mode`),
 * which it sends even where it leaves `Origin` out — a no-cors GET, an <img>, a <script>.
 *
 * From another site, only a plain page visit is let through: that is the DevLaunch
 * website's "Run on my computer" link opening the dashboard, which then only fills in a
 * form. Anything else from another site — a background request, or a form posted at
 * DevLaunch — is refused. Tools and same-origin requests are unaffected: curl sends no such
 * header, and the dashboard's own requests say `same-origin`.
 */
export function fetchSiteAllowed(site: string | undefined, mode: string | undefined, method: string): boolean {
  if (site !== 'cross-site' && site !== 'same-site') return true;
  return (method === 'GET' || method === 'HEAD') && mode === 'navigate';
}

/** Extra names from `DEVLAUNCH_ALLOWED_HOSTS` (comma-separated) and a non-loopback bind host. */
export function configuredHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  const out = (env.DEVLAUNCH_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean);
  const bind = env.DEVLAUNCH_HOST?.trim();
  if (bind && bind !== '0.0.0.0' && bind !== '::') out.push(bind);
  return out;
}

export function hostGuard(allowed: ReadonlySet<string>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!hostAllowed(req.headers.host, allowed)) {
      res.status(421).json({
        error: {
          code: 'HOST_NOT_ALLOWED',
          category: 'VALIDATION_ERROR',
          message: `DevLaunch answers requests addressed to this machine (localhost), not to "${String(req.headers.host ?? '').slice(0, 80)}".`,
          retryable: false,
          suggestedAction: 'Open http://127.0.0.1:3939, or add the name to DEVLAUNCH_ALLOWED_HOSTS if you serve DevLaunch under another one.',
        },
      });
      return;
    }
    const site = req.headers['sec-fetch-site'];
    const mode = req.headers['sec-fetch-mode'];
    if (
      !originAllowed(req.headers.origin, allowed) ||
      !fetchSiteAllowed(typeof site === 'string' ? site : undefined, typeof mode === 'string' ? mode : undefined, req.method)
    ) {
      res.status(403).json({
        error: {
          code: 'ORIGIN_NOT_ALLOWED',
          category: 'VALIDATION_ERROR',
          message: 'A page from another site cannot use DevLaunch.',
          retryable: false,
          suggestedAction: 'Use the dashboard at http://127.0.0.1:3939.',
        },
      });
      return;
    }
    next();
  };
}
