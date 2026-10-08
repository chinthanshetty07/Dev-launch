/**
 * DevLaunch inside a GitHub Codespace.
 *
 * There, "this machine" is a cloud container, and the person's browser is on their own
 * computer: `http://localhost:3000` in a link DevLaunch shows would open *their* port 3000,
 * where nothing is. GitHub forwards each port the codespace opens to its own address —
 * `https://<codespace>-<port>.<forwarding domain>/` — and that is the address a browser
 * can use.
 *
 * So DevLaunch keeps working with `localhost` inside — its own checks reach services there —
 * and translates at the edges: every address it shows to a person, or hands to a page a
 * browser runs, becomes the forwarded one; and a forwarded address it is given back becomes
 * `localhost` again before it is checked. Outside a codespace both are the identity.
 */

export interface CodespaceEnv {
  name: string;
  domain: string;
}

/** The codespace DevLaunch is running in, from the variables GitHub sets in every one. */
export function codespace(env: NodeJS.ProcessEnv = process.env): CodespaceEnv | null {
  const name = env.CODESPACE_NAME?.trim();
  const domain = env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN?.trim();
  if (env.CODESPACES !== 'true' || !name || !domain) return null;
  if (!/^[a-z0-9-]+$/i.test(name) || !/^[a-z0-9.-]+$/i.test(domain)) return null;
  return { name, domain };
}

const LOCAL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1):(\d{2,5})(?=[/?#"'\s]|$)/g;

/** Every `http://localhost:PORT` in some text, as the address a browser can reach. */
export function toPublic(text: string, cs: CodespaceEnv | null = codespace()): string {
  if (!cs) return text;
  return text.replace(LOCAL, (_m, port: string) => `https://${cs.name}-${port}.${cs.domain}`);
}

/** A forwarded address back to `http://localhost:PORT`, so DevLaunch can check it itself. */
export function toLocal(url: string, cs: CodespaceEnv | null = codespace()): string {
  if (!cs) return url;
  const host = new RegExp(`^https://${cs.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d{2,5})\\.${cs.domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
  return url.replace(host, (_m, port: string) => `http://localhost:${port}`);
}

/**
 * The ports apps are published on in a codespace. Declared in `.devcontainer/devcontainer.json`
 * (`forwardPorts`), so GitHub forwards them whether or not an editor is open: a port it only
 * *notices* — Docker's random 32768 — was forwarded only while a browser editor watched, and
 * the link DevLaunch gave answered 404 otherwise (seen in the first real codespace).
 */
export const CODESPACE_APP_PORTS: readonly number[] = Array.from({ length: 20 }, (_, i) => 4100 + i);

/** The name the dashboard is opened by in a codespace, so the host check lets it through. */
export function dashboardHost(port: number, cs: CodespaceEnv | null = codespace()): string | null {
  return cs ? `${cs.name}-${port}.${cs.domain}` : null;
}
