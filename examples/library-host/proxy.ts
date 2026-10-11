/**
 * Small `node:http` proxy (issue #260, about 60 lines) that keeps the Agent Viewer server's API token out of
 * the browser. It is the ONLY file in `examples/library-host/` (besides its own `README.md`) that references
 * `AGENT_VIEWER_API_TOKEN`; the rest of the example never reads a token, so the Vite bundle served to the
 * browser never contains one (`tests/library-host-proxy.test.mjs` checks this statically).
 *
 * Forwards only `GET` requests on a fixed allowlist (the rollup and calls read endpoints, issues #66/#67) to
 * the real server, adding its own `Authorization: Bearer <token>` header; any client-sent `Authorization` is
 * dropped, never forwarded. Everything else (another method, another path) gets `405`/`404`. Binds `127.0.0.1`
 * only. This proxy has no login of its own: anyone who can reach it can read every figure the server's token
 * can see, so a real deployment must put it behind the host application's own authentication (see README.md).
 */
import http, { type IncomingMessage, type ServerResponse } from 'node:http';

/** Exact paths this proxy will forward. A query string is allowed; an unlisted path is not. */
const ALLOWED_PATHS = ['/api/v1/usage/rollup', '/api/v1/usage/calls'];

export interface CreateProxyOptions {
  /** Base URL of the Agent Viewer server, for example `http://127.0.0.1:8787`. */
  upstream: string;
  /** The server's own API token. Never logged, never sent back in a response. */
  token: string;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function forward(req: IncomingMessage, res: ServerResponse, upstream: URL, token: string): void {
  const requestUrl = new URL(req.url ?? '/', 'http://proxy.invalid');
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }
  if (!ALLOWED_PATHS.includes(requestUrl.pathname)) {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }

  const target = new URL(requestUrl.pathname + requestUrl.search, upstream);
  const upstreamReq = http.request(
    target,
    {
      method: 'GET',
      // Only these two headers are sent upstream: the client's own `Authorization` (if any) is never read,
      // let alone forwarded, so a browser can never smuggle a different credential through this proxy.
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    },
    (upstreamRes) => {
      const headers = { ...upstreamRes.headers };
      delete headers['set-cookie'];
      delete headers['www-authenticate'];
      delete headers['access-control-allow-origin'];
      res.writeHead(upstreamRes.statusCode ?? 502, headers);
      upstreamRes.pipe(res);
    },
  );
  upstreamReq.on('error', () => sendJson(res, 502, { error: 'upstream_unreachable' }));
  upstreamReq.end();
}

/** Throws synchronously on an empty token, before anything binds a port: there is nothing safe this proxy can
 * do without one, so it must never start half-configured. */
export function createProxy({ upstream, token }: CreateProxyOptions): http.Server {
  if (token.length === 0) {
    throw new Error('AGENT_VIEWER_API_TOKEN is empty: refusing to start the proxy without a token.');
  }
  const upstreamUrl = new URL(upstream);
  return http.createServer((req, res) => forward(req, res, upstreamUrl, token));
}

const isEntryPoint = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isEntryPoint) {
  const upstream = process.env.AGENT_VIEWER_UPSTREAM ?? 'http://127.0.0.1:8787';
  const token = process.env.AGENT_VIEWER_API_TOKEN ?? '';
  const port = Number(process.env.LIBRARY_HOST_PROXY_PORT ?? 8788);
  try {
    const server = createProxy({ upstream, token });
    server.listen(port, '127.0.0.1', () => {
      console.log(`[library-host proxy] listening on http://127.0.0.1:${port}, forwarding reads to ${upstream}`);
    });
  } catch (error) {
    console.error(`[library-host proxy] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
