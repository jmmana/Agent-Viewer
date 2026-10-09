import { useEffect, useState } from 'react';

/**
 * Whether the connected server's `/api/v1` asks for a token, read from `GET /health`.
 * `'unknown'` covers a network error, a non-200 response, an older server with no `auth` field, or no
 * successful poll yet: it never claims the server is open or protected without evidence.
 */
export type ServerAuthState = 'token' | 'open' | 'unknown';

/** How often `useServerAuthState` polls `/health` while mounted. */
export const SERVER_HEALTH_POLL_MS = 60_000;

/** Reads `GET {apiBase}/health`. Never sends an Authorization header, since `/health` is always public. */
export async function fetchServerAuthState(
  apiBase: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<ServerAuthState> {
  try {
    const response = await fetchImpl(`${apiBase.replace(/\/$/, '')}/health`, {
      cache: 'no-store',
      signal,
    });
    if (!response.ok) return 'unknown';
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null || !('auth' in body)) return 'unknown';
    const auth = (body as { auth: unknown }).auth;
    return auth === 'open' || auth === 'token' ? auth : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Polls `fetchServerAuthState` every `SERVER_HEALTH_POLL_MS` while `apiBase` is defined. No request is made
 * while `apiBase` is `undefined` (demo/simulation mode). A failed poll after a known state keeps that state,
 * so a transient blip does not flicker the banner; the state starts, and resets to, `'unknown'` otherwise.
 */
export function useServerAuthState(apiBase: string | undefined): ServerAuthState {
  const [state, setState] = useState<ServerAuthState>('unknown');

  useEffect(() => {
    setState('unknown');
    if (!apiBase) return;

    let active = true;
    let inFlight = false;
    let controller: AbortController | undefined;

    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      const requestController = new AbortController();
      controller = requestController;
      const nextState = await fetchServerAuthState(apiBase, fetch, requestController.signal);
      if (active && nextState !== 'unknown') setState(nextState);
      if (controller === requestController) controller = undefined;
      inFlight = false;
    };

    void poll();
    const timer = window.setInterval(() => void poll(), SERVER_HEALTH_POLL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
      controller?.abort();
    };
  }, [apiBase]);

  return state;
}
