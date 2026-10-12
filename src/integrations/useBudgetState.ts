/**
 * Owns every fetch the Budgets tab needs (issue #334, sub-issue of #88): `GET /api/v1/budgets` (via
 * `serverApi.getBudgets`, which is both "list budgets" and "read budget state" at once, see `serverApi.ts`'s
 * doc comment) fetched when `serverApi` becomes available, when the Budgets tab opens, after a successful
 * budget write (the panel calls `refresh()`), on a 30s timer, and on a throttled trailing refresh after a new
 * `llm.usage` event (at most one request every `BUDGET_STATE_EVENT_THROTTLE_MS`).
 *
 * Mirrors `src/components/modelOps/useModelOpsLedger.ts`'s discipline:
 *  - A monotonically increasing request id means a response from an older request is dropped if a newer request
 *    has since started, so responses are applied in request order and an older one never overwrites a newer one.
 *  - A failed request never clears the last good `budgets`/`asOf`: it only sets `stale: true` and an
 *    `errorMessage`, so a chip or progress bar already on screen never loses its color because of a transient
 *    network blip (issue #88 section 1's "network errors keep the last good data with a visible stale marker").
 *  - `status` only ever reaches `'error'` when there has never been a single successful response; once a
 *    response has landed, `status` stays `'ready'` forever after (even through later failures), and only
 *    `stale`/`errorMessage` move.
 *
 * This hook never computes a budget's `spent`, `ratio` or `state`: `getBudgets`'s zod-validated response is
 * applied to local state field for field. See `BudgetsPanel.tsx` for the same rule on the rendering side.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { BudgetView, ServerApi } from './serverApi';
import type { ViewerEvent } from '../types/agent';

export const BUDGET_STATE_REFRESH_INTERVAL_MS = 30_000;
export const BUDGET_STATE_EVENT_THROTTLE_MS = 5_000;

export type BudgetStateStatus = 'idle' | 'loading' | 'ready' | 'error';

interface BudgetStateFields {
  status: BudgetStateStatus;
  budgets: BudgetView[];
  /** `generatedAt` from the last successful response, never from a failed one. */
  asOf: number | null;
  /** `true` when the most recent request failed; the data above is still the last good response. */
  stale: boolean;
  errorMessage: string | null;
}

export interface BudgetStateResult extends BudgetStateFields {
  /** Fetches immediately, bypassing the 30s timer and the event throttle. The panel calls this after a
   * successful create/update/delete so the list reflects the write without waiting for the next tick. */
  refresh: () => void;
}

export interface UseBudgetStateOptions {
  /** `null` while the server API is not yet available (demo mode, or the token/connection still resolving):
   * no request is ever made. */
  serverApi: ServerApi | null;
  /** Fetching only happens while this is `true`; callers pass whether the Budgets tab is the active tab (and
   * the modal itself is open), so switching away stops the 30s timer and any pending throttle. */
  isOpen: boolean;
  /** Watched for new `llm.usage` event ids to trigger the throttled refresh. */
  events?: ViewerEvent[];
  /** Injectable clock for tests. Defaults to `Date.now`. */
  now?: () => number;
}

const INITIAL_STATE: BudgetStateFields = {
  status: 'idle',
  budgets: [],
  asOf: null,
  stale: false,
  errorMessage: null,
};

export function useBudgetState(options: UseBudgetStateOptions): BudgetStateResult {
  const { serverApi, isOpen, events = [] } = options;

  // Kept in a ref, not a dependency: an inline `now` (every test, and any caller that does not memoize it) would
  // otherwise give every effect below a new function identity on every render (see useModelOpsLedger.ts).
  const nowRef = useRef(options.now ?? Date.now);
  nowRef.current = options.now ?? Date.now;

  const [state, setState] = useState<BudgetStateFields>(INITIAL_STATE);

  const requestIdRef = useRef(0);
  const lastFetchAtRef = useRef(0);
  const throttleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seenEventIdsRef = useRef<Set<string> | null>(null);
  const serverApiRef = useRef(serverApi);
  serverApiRef.current = serverApi;

  const fetchNow = useCallback(() => {
    const api = serverApiRef.current;
    if (!api) return;
    const requestId = ++requestIdRef.current;
    lastFetchAtRef.current = nowRef.current();

    void (async () => {
      const result = await api.getBudgets();
      // A newer request has since started (or already landed): this response is stale, drop it. Never let it
      // overwrite more recent data, win a race against a newer success, or clear a newer error's stale marker.
      if (requestIdRef.current !== requestId) return;

      if (result.ok) {
        setState({
          status: 'ready',
          budgets: result.data.budgets,
          asOf: result.data.generatedAt,
          stale: false,
          errorMessage: null,
        });
      } else {
        setState((prev) => ({
          ...prev,
          status: prev.status === 'ready' ? 'ready' : 'error',
          stale: true,
          errorMessage: result.message ?? result.kind,
        }));
      }
    })();
  }, []);

  const refresh = useCallback(() => {
    fetchNow();
  }, [fetchNow]);

  // ---- Fetch when serverApi becomes available / the tab opens, plus the 30s refresh timer ----
  useEffect(() => {
    if (!isOpen || !serverApi) return;
    setState((prev) => (prev.status === 'idle' ? { ...prev, status: 'loading' } : prev));
    fetchNow();
    const interval = setInterval(fetchNow, BUDGET_STATE_REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [isOpen, serverApi, fetchNow]);

  // ---- Throttled, trailing refresh after a new llm.usage event: at most one request per throttle window ----
  useEffect(() => {
    if (!isOpen || !serverApi) {
      seenEventIdsRef.current = null;
      if (throttleTimerRef.current !== null) {
        clearTimeout(throttleTimerRef.current);
        throttleTimerRef.current = null;
      }
      return;
    }

    if (seenEventIdsRef.current === null) {
      // First time this hook sees events while active: seed with what is already there, so events the initial
      // fetch above already covers never trigger an immediate, redundant refetch.
      seenEventIdsRef.current = new Set(events.filter((event) => event.type === 'llm.usage').map((event) => event.id));
      return;
    }

    const seen = seenEventIdsRef.current;
    const unseen = events.filter((event) => event.type === 'llm.usage' && !seen.has(event.id));
    if (unseen.length === 0) return;
    for (const event of unseen) seen.add(event.id);

    // A trailing fetch is already scheduled: later events in the same window ride along with it instead of
    // pushing it further out or firing a second request.
    if (throttleTimerRef.current !== null) return;

    const elapsed = nowRef.current() - lastFetchAtRef.current;
    if (elapsed >= BUDGET_STATE_EVENT_THROTTLE_MS) {
      fetchNow();
    } else {
      throttleTimerRef.current = setTimeout(() => {
        throttleTimerRef.current = null;
        fetchNow();
      }, BUDGET_STATE_EVENT_THROTTLE_MS - elapsed);
    }
  }, [events, isOpen, serverApi, fetchNow]);

  // Clears any pending throttle timer on unmount.
  useEffect(
    () => () => {
      if (throttleTimerRef.current !== null) clearTimeout(throttleTimerRef.current);
    },
    []
  );

  return { ...state, refresh };
}
