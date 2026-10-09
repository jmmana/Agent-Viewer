/**
 * Where the demo app streams events from, and with which token.
 *
 * - `VITE_AGENT_VIEWER_API_URL` names the server. The value `same-origin` means "the server that serves this
 *   page", which is how the `agent-viewer` CLI ships the office.
 * - Without it, live mode connects to `http://localhost:8787`, as before.
 * - The token comes from the URL fragment (`#token=...`), which the browser never sends to a server, or from
 *   the `token` query parameter. The `agent-viewer` CLI opens the browser with `#launch=<code>` instead: a
 *   single-use code the office trades for the token, so the token never travels in the browser's argv.
 * - `takeLiveCredentials` removes `token` and `launch` from the address bar (`history.replaceState`) as soon
 *   as it reads them, and keeps the token in `sessionStorage`, so a reload of the same tab still connects.
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

/** Path where the office trades a launch code for the token. Mirrors `LAUNCH_PATH` in `cli/start.ts`. */
export const LAUNCH_PATH = '/api/cli/launch';
export const LIVE_TOKEN_STORAGE_KEY = 'agent-viewer:live-token';

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

/** The address without `token` and `launch` in the fragment and `token` in the query, or `undefined` if none. */
export function addressWithoutCredentials(location: LocationLike & { pathname: string }): string | undefined {
  const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
  const query = new URLSearchParams(location.search);
  if (!hash.has('token') && !hash.has('launch') && !query.has('token')) return undefined;
  hash.delete('token');
  hash.delete('launch');
  query.delete('token');
  const search = query.toString();
  const fragment = hash.toString();
  return `${location.pathname}${search ? `?${search}` : ''}${fragment ? `#${fragment}` : ''}`;
}

export interface BrowserLike {
  location: LocationLike & { pathname: string };
  history: Pick<History, 'replaceState' | 'state'>;
  sessionStorage?: Pick<Storage, 'getItem' | 'setItem'>;
}

function storage(win: BrowserLike): Pick<Storage, 'getItem' | 'setItem'> | undefined {
  try {
    return win.sessionStorage;
  } catch {
    // Storage blocked by the browser: the token lives only in memory.
    return undefined;
  }
}

/**
 * Reads the credentials of the address, then removes them from the address bar and from this history entry.
 * Returns the token (from the address, else from this tab's storage) and a launch code to redeem, if any.
 */
export function takeLiveCredentials(win: BrowserLike): { token?: string; launchCode?: string } {
  const hash = new URLSearchParams(win.location.hash.replace(/^#/, ''));
  const fromAddress = hash.get('token') || new URLSearchParams(win.location.search).get('token') || undefined;
  const launchCode = hash.get('launch') || undefined;
  const store = storage(win);
  if (fromAddress) {
    try {
      store?.setItem(LIVE_TOKEN_STORAGE_KEY, fromAddress);
    } catch {
      // Quota or privacy mode: keep going with the token in memory.
    }
  }
  const clean = addressWithoutCredentials(win.location);
  if (clean !== undefined) {
    try {
      win.history.replaceState(win.history.state, '', clean);
    } catch {
      // Some embedded browsers forbid replaceState; the token then stays visible, as before.
    }
  }
  let stored: string | undefined;
  try {
    stored = store?.getItem(LIVE_TOKEN_STORAGE_KEY) ?? undefined;
  } catch {
    stored = undefined;
  }
  return { token: fromAddress ?? stored, launchCode };
}

const launches = new Map<string, Promise<string | undefined>>();

/** Trades a launch code for the token. One request per code, even if React runs the effect twice. */
export function redeemLaunchCode(apiBase: string, code: string, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  const key = `${apiBase} ${code}`;
  let pending = launches.get(key);
  if (!pending) {
    pending = fetchImpl(`${apiBase.replace(/\/$/, '')}${LAUNCH_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
      cache: 'no-store',
    })
      .then(async (response) => {
        if (!response.ok) return undefined;
        const body = (await response.json()) as { token?: unknown };
        return typeof body.token === 'string' && body.token !== '' ? body.token : undefined;
      })
      .catch(() => undefined);
    launches.set(key, pending);
  }
  return pending;
}

let pendingLaunch: { apiBase: string; code: string } | undefined;

/**
 * The token for the live stream: from the address (then removed from it), from a launch code, or from this
 * tab's storage after a reload.
 */
export async function loadLiveToken(win: BrowserLike, apiBase: string, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  const { token, launchCode } = takeLiveCredentials(win);
  if (launchCode) pendingLaunch = { apiBase, code: launchCode };
  if (pendingLaunch && pendingLaunch.apiBase === apiBase) {
    const granted = await redeemLaunchCode(pendingLaunch.apiBase, pendingLaunch.code, fetchImpl);
    if (granted) {
      try {
        storage(win)?.setItem(LIVE_TOKEN_STORAGE_KEY, granted);
      } catch {
        // Memory only.
      }
      return granted;
    }
  }
  return token;
}
