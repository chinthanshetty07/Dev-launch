import type Dockerode from 'dockerode';
import type { DockerManager } from '../docker/DockerManager.js';

export interface ListeningSocket {
  port: number;
  address: string;
  /** True when the socket is bound to loopback and therefore unreachable via Docker. */
  loopbackOnly: boolean;
}

export type PortDiagnosis =
  | { kind: 'listening'; socket: ListeningSocket }
  | { kind: 'loopback-only'; socket: ListeningSocket }
  /** Open, reachable, and on a port other than the one the plan expects. */
  | { kind: 'other-port'; socket: ListeningSocket }
  | { kind: 'not-listening'; observed: ListeningSocket[] };

/**
 * Docker's embedded DNS resolver, present in every container on a user-defined network.
 *
 * It is always listening and is never the application, so counting it would turn "one
 * socket, on the wrong port" — an answer — into "several sockets", which is not one.
 */
const DOCKER_DNS = '127.0.0.11';

/** LISTEN in /proc/net/tcp's state column. */
const TCP_LISTEN = '0A';

/** Decode the little-endian hex address used by /proc/net/tcp. */
function decodeIPv4(hex: string): string {
  return [6, 4, 2, 0].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join('.');
}

function isIPv6Loopback(hex: string): boolean {
  // ::1 appears as 28 zeros followed by 01000000 in /proc/net/tcp6.
  return /^0{24}0*1000000$/i.test(hex) || /^0{31}1$/i.test(hex);
}

export function parseProcNetTcp(content: string, ipv6 = false): ListeningSocket[] {
  const out: ListeningSocket[] = [];
  for (const line of content.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4) continue;
    const local = fields[1];
    const state = fields[3];
    if (!local || state !== TCP_LISTEN) continue;

    const [addrHex, portHex] = local.split(':');
    if (!addrHex || !portHex) continue;
    const port = Number.parseInt(portHex, 16);
    if (!Number.isInteger(port) || port <= 0) continue;

    if (ipv6) {
      out.push({
        port,
        address: isIPv6Loopback(addrHex) ? '::1' : '::',
        loopbackOnly: isIPv6Loopback(addrHex),
      });
    } else {
      const address = decodeIPv4(addrHex);
      out.push({ port, address, loopbackOnly: address.startsWith('127.') });
    }
  }
  return out;
}

/**
 * Port discovery.
 *
 * Host ports are always read back from the Docker API rather than scanned. When an
 * application ignores the port it was given, the container's own /proc is consulted —
 * that is introspection of a process we started, not scanning of the host.
 */
export class PortManager {
  constructor(private readonly docker: DockerManager) {}

  /** The host port Docker assigned, or null if the mapping is absent (e.g. stopped). */
  async hostPortFor(
    container: Dockerode.Container,
    internalPort: number | null,
  ): Promise<string | null> {
    if (!internalPort) return null;
    const info = await this.docker.inspect(container);
    return info.NetworkSettings?.Ports?.[`${internalPort}/tcp`]?.[0]?.HostPort ?? null;
  }

  async listeningSockets(container: Dockerode.Container): Promise<ListeningSocket[]> {
    const [v4, v6] = await Promise.all([
      this.docker.execCapture(container, ['cat', '/proc/net/tcp']).catch(() => ''),
      this.docker.execCapture(container, ['cat', '/proc/net/tcp6']).catch(() => ''),
    ]);
    return [...parseProcNetTcp(v4, false), ...parseProcNetTcp(v6, true)];
  }

  /**
   * Explain why an expected port is not reachable.
   *
   * The distinction that matters: an application bound to 127.0.0.1 inside a container
   * is healthy and listening, yet Docker's port mapping resolves to nothing. That is a
   * completely different problem from a port that never opened, and the remedy — bind
   * 0.0.0.0 — is different too.
   */
  async diagnose(
    container: Dockerode.Container,
    expectedPort: number | null,
  ): Promise<PortDiagnosis> {
    const sockets = await this.listeningSockets(container);
    const app = sockets.filter((s) => s.address !== DOCKER_DNS);

    const onExpected = expectedPort ? app.filter((s) => s.port === expectedPort) : app;

    const reachable = onExpected.find((s) => !s.loopbackOnly);
    if (reachable) return { kind: 'listening', socket: reachable };

    const loopback = onExpected.find((s) => s.loopbackOnly);
    if (loopback) return { kind: 'loopback-only', socket: loopback };

    // Nothing on the expected port, but the application is plainly listening somewhere.
    // "Nothing is listening on port 3000" was true and useless: the process had opened
    // 8017 and said so in its own log, and the only responder that noticed was a model
    // guessing at a new start command. One socket is an answer; several are a guess, so
    // only one is reported.
    const elsewhere = app.filter((s) => s.port !== expectedPort);
    if (elsewhere.length === 1) return { kind: 'other-port', socket: elsewhere[0]! };

    return { kind: 'not-listening', observed: sockets };
  }
}
