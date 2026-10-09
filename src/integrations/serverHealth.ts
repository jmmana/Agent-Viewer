import { useEffect, useState } from 'react';

export type ServerAuthState = 'token' | 'open' | 'unknown';

export const SERVER_HEALTH_POLL_MS = 60_000;

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
    return body.auth === 'open' || body.auth === 'token' ? body.auth : 'unknown';
  } catch {
    return 'unknown';
  }
}

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
