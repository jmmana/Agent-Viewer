/**
 * Turns the portal's already-resolved live connection into a `ServerApi` (issue #88, sub-issue #332).
 *
 * The portal already has exactly the connection shape this needs: `useModelOpsLedger.ts`'s `LedgerConnection`
 * (issue #79), built from `resolveLiveConnection`/`loadLiveToken` (`liveConnection.ts`, PR #42) the same way
 * `src/App.tsx` builds it today. Rather than introduce a second, parallel way to resolve `apiBase`/the token
 * (a React context duplicating state `App.tsx` already owns), this hook takes that same `{ baseUrl, token,
 * tokenResolved }` value directly, exactly like `fetchRollup`/`fetchCalls` in `ledgerClient.ts` take a base and
 * a token as plain arguments instead of reading them from a context. A consumer (the pricing editor, the
 * budgets panel) calls `useServerApi(connection)` with whatever connection value it already has in scope.
 *
 * Returns `null` in two cases, matching issue #88 section 1 ("returns null when there is no apiBase (plain demo
 * mode). In demo mode no request is made.") plus the token-resolution rule from the same section ("Requests
 * wait for the token resolution... before the first call"):
 *  - `connection` is `null` (no `apiBase`: demo mode).
 *  - `connection.tokenResolved` is `false` (the token is still being read from the URL fragment, a launch code
 *    or `sessionStorage`; see `liveConnection.ts`). Once resolved, `tokenResolved` is `true` even when the
 *    resolution ended in "no token" (an open server), which is the moment a request is safe to send.
 */
import { useMemo } from 'react';
import { createServerApi, type ServerApi } from './serverApi';

export interface LiveConnection {
  baseUrl: string;
  /** `undefined` while still resolving, or once resolved on an open server with no token configured. */
  token?: string;
  /** `false` while the token is still resolving (URL fragment, launch code or `sessionStorage`, all async). */
  tokenResolved: boolean;
}

export function useServerApi(connection: LiveConnection | null): ServerApi | null {
  const baseUrl = connection?.baseUrl;
  const token = connection?.token;
  const tokenResolved = connection?.tokenResolved ?? false;

  return useMemo(() => {
    if (!baseUrl || !tokenResolved) return null;
    return createServerApi({
      apiBase: baseUrl,
      getToken: async () => token,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl, token, tokenResolved]);
}
