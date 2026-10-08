/**
 * Where the demo app streams events from, and with which token.
 *
 * - `VITE_AGENT_VIEWER_API_URL` names the server. The value `same-origin` means "the server that serves this
 *   page", which is how the `agent-viewer` CLI ships the office.
 * - Without it, live mode connects to `http://localhost:8787`, as before.
 * - The token comes from the URL fragment (`#token=...`), which the browser never sends to a server, or from
 *   the `token` query parameter.
 */
export interface LiveConnection {
  apiBase?: string;
  token?: string;
}

export interface LocationLike {
  origin: string;
  search: string;
  hash: string;
}

export function resolveLiveConnection(
  location: LocationLike,
  configuredApiUrl: string | undefined,
  isLiveMode: boolean,
): LiveConnection {
  const configured = configuredApiUrl?.trim();
  const apiBase = configured === 'same-origin'
    ? location.origin
    : configured || (isLiveMode ? 'http://localhost:8787' : undefined);

  const fromHash = new URLSearchParams(location.hash.replace(/^#/, '')).get('token');
  const fromQuery = new URLSearchParams(location.search).get('token');
  const token = fromHash || fromQuery || undefined;

  return { apiBase, token };
}
