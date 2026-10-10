/**
 * Pure helpers for deciding whether a host or a remote address counts as loopback (issue #71). No side
 * effects and no imports from the rest of the server, so both `server/index.ts` and the CLI can share a
 * single definition of "loopback" instead of keeping their own private sets in sync by hand.
 */

/** `127.0.0.1` through `127.255.255.255`: the whole `127.0.0.0/8` block, not just the one literal. */
function isLoopbackIpv4(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 4 || parts[0] !== '127') return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/**
 * True for `localhost`, `::1`, `[::1]` and any `127.0.0.0/8` literal. Everything else, including `0.0.0.0`,
 * `::`, an empty string and any other hostname, is non-loopback. No DNS resolution: a hostname that happens to
 * resolve to loopback (for example one added to `/etc/hosts`) is still treated as non-loopback here.
 */
export function isLoopbackHost(host: string): boolean {
  const value = host.trim();
  if (value === '') return false;
  if (value === 'localhost' || value === '::1' || value === '[::1]') return true;
  return isLoopbackIpv4(value);
}

const IPV4_MAPPED = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;

/**
 * True for the same literals as `isLoopbackHost` plus the IPv4-mapped forms Node reports for a loopback
 * connection on a dual-stack socket (`::ffff:127.0.0.1`). An `undefined` address (the value of
 * `req.socket.remoteAddress` once the socket has already closed) is treated as non-loopback.
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  const value = address.trim();
  if (isLoopbackHost(value)) return true;
  const mapped = IPV4_MAPPED.exec(value);
  return mapped ? isLoopbackIpv4(mapped[1]) : false;
}

/** Reads `AGENT_VIEWER_HOST`, defaulting to loopback. A blank value counts as unset. */
export function envHost(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.AGENT_VIEWER_HOST;
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  return trimmed === '' ? '127.0.0.1' : trimmed;
}

/** Whether `AGENT_VIEWER_ALLOW_OPEN=1` is set. Any other value, including blank or `0`, is ignored. */
export function isOpenModeAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AGENT_VIEWER_ALLOW_OPEN === '1';
}

/** Thrown by `assertSafeBind` when a bind would leave the ledger open to the network with no token. */
export class OpenApiRefusedError extends Error {
  readonly code = 'open_api_refused' as const;

  constructor(readonly host: string, readonly port: number) {
    super(
      `[agent-viewer] Refusing to listen on ${host}:${port} without AGENT_VIEWER_API_TOKEN: anyone on the ` +
        'network could read and write the usage ledger. Set AGENT_VIEWER_API_TOKEN, or bind 127.0.0.1 ' +
        '(AGENT_VIEWER_HOST), or set AGENT_VIEWER_ALLOW_OPEN=1 to accept an open API.'
    );
    this.name = 'OpenApiRefusedError';
  }
}

/**
 * Throws `OpenApiRefusedError` when binding `host` would leave `/api/v1` open to the network: the host is not
 * loopback, no token is configured and the operator has not explicitly opted into an open API with
 * `AGENT_VIEWER_ALLOW_OPEN=1`. Called before `app.listen`, by `startServer` and by the direct run.
 */
export function assertSafeBind(
  host: string,
  port: number,
  options: { hasToken: boolean; env?: NodeJS.ProcessEnv }
): void {
  if (isLoopbackHost(host)) return;
  if (options.hasToken) return;
  if (isOpenModeAllowed(options.env)) return;
  throw new OpenApiRefusedError(host, port);
}
