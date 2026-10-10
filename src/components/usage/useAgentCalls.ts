/**
 * Cursor-paginated list of one agent's ledger calls for `AgentDetailModal`'s metrics tab "View calls" section
 * (issue #78). Mirrors `useModelOpsLedger`'s `feed` sub-state (issue #79, `src/components/modelOps/
 * useModelOpsLedger.ts`) and `useLedgerAgentUsage`'s refetch-on-event rules, scoped to one agent and capped at
 * `AGENT_CALLS_DISPLAY_CAP` rendered rows so a very active agent cannot grow the list without bound.
 *
 * Only active while `enabled` is true (the modal is open on this agent's metrics tab): it never fetches in the
 * background for an agent nobody is looking at. Changing agent or window resets the list and refetches page 1.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ViewerEvent } from '../../types/agent';
import { fetchCalls, type CallRecord, type LedgerResult } from '../../integrations/ledgerClient';
import { usageWindowRange, type UsageWindowOption } from '../../integrations/usageWindow';
import type { LedgerConnection, QueryState } from '../modelOps/useModelOpsLedger';

export const AGENT_CALLS_PAGE_SIZE = 50;
/** Hard cap on rendered rows (issue #78): `loadMore` stops requesting further pages once this many calls are
 * loaded, and the table shows a "showing the N most recent calls" hint instead. */
export const AGENT_CALLS_DISPLAY_CAP = 500;
const REFRESH_DEBOUNCE_MS = 1500;
const REFRESH_MIN_INTERVAL_MS = 5000;

function resolvedAgentId(event: ViewerEvent): string {
  return event.agentId ?? event.source.replace(/^agent:/, '');
}

function isUsageOrFailedEventFor(event: ViewerEvent, agentId: string): boolean {
  return (event.type === 'llm.usage' || event.type === 'llm.failed') && resolvedAgentId(event) === agentId;
}

export interface UseAgentCallsOptions {
  /** `null` means demo mode or an unavailable ledger: no fetch is ever made. */
  ledger: LedgerConnection | null;
  agentId: string;
  window: UsageWindowOption;
  /** Only the open metrics tab of the detail modal sets this `true`; every other render stays idle. */
  enabled: boolean;
  events: ViewerEvent[];
  now?: () => number;
}

export interface UseAgentCallsResult {
  /** Status of the first page only; `loadMore` has its own `loadingMore` / `loadMoreError`. */
  query: QueryState<null>;
  calls: CallRecord[];
  /** `false` once the display cap is reached, even if the server still has more (`atCap` covers that case). */
  hasMore: boolean;
  atCap: boolean;
  loadingMore: boolean;
  loadMoreError: string | null;
  loadMore: () => void;
  retry: () => void;
}

interface CallsState {
  query: QueryState<null>;
  calls: CallRecord[];
  hasMore: boolean;
  nextCursor: string | null;
  loadingMore: boolean;
  loadMoreError: string | null;
}

const INITIAL_STATE: CallsState = {
  query: { status: 'idle' },
  calls: [],
  hasMore: false,
  nextCursor: null,
  loadingMore: false,
  loadMoreError: null,
};

function toFirstPageQueryState(result: LedgerResult<unknown>): QueryState<null> {
  if (result.kind === 'ok') return { status: 'ready', data: null };
  if (result.kind === 'unavailable') return { status: 'unavailable' };
  if (result.kind === 'unauthorized') return { status: 'unauthorized' };
  return { status: 'error', message: result.message };
}

export function useAgentCalls(options: UseAgentCallsOptions): UseAgentCallsResult {
  const { ledger, agentId, window: usageWindow, enabled, events } = options;
  // Kept in a ref so an inline `now` (every test, and any caller that does not memoize it) never gives the
  // effects below a new dependency identity on every render.
  const nowRef = useRef(options.now ?? Date.now);
  nowRef.current = options.now ?? Date.now;

  const [state, setState] = useState<CallsState>(INITIAL_STATE);
  const [retryTick, setRetryTick] = useState(0);
  const requestId = useRef(0);

  const ledgerBase = ledger?.baseUrl;
  const ledgerToken = ledger?.token;
  const ledgerTokenResolved = ledger?.tokenResolved ?? false;

  const retry = useCallback(() => setRetryTick((tick) => tick + 1), []);

  const fetchFirstPage = useCallback(() => {
    if (!ledgerBase || !ledgerTokenResolved) return;
    const id = ++requestId.current;
    setState((prev) => ({ ...prev, query: { status: 'loading' } }));
    const { from, to } = usageWindowRange(usageWindow, nowRef.current());
    void (async () => {
      const result = await fetchCalls(ledgerBase, ledgerToken, {
        limit: AGENT_CALLS_PAGE_SIZE,
        agentId: [agentId],
        from,
        to,
      });
      if (requestId.current !== id) return;
      if (result.kind !== 'ok') {
        setState({ ...INITIAL_STATE, query: toFirstPageQueryState(result) });
        return;
      }
      setState({
        query: { status: 'ready', data: null },
        calls: result.data.data,
        hasMore: result.data.page.hasMore,
        nextCursor: result.data.page.nextCursor,
        loadingMore: false,
        loadMoreError: null,
      });
    })();
  }, [ledgerBase, ledgerToken, ledgerTokenResolved, usageWindow, agentId]);

  // ---- First page: on enabling, on agent/window change, and on manual retry ----
  useEffect(() => {
    if (!enabled || !ledgerBase) {
      setState(INITIAL_STATE);
      return;
    }
    if (!ledgerTokenResolved) {
      setState((prev) => ({ ...prev, query: { status: 'loading' } }));
      return;
    }
    fetchFirstPage();
  }, [enabled, ledgerBase, ledgerTokenResolved, fetchFirstPage, retryTick]);

  const loadMore = useCallback(() => {
    if (!ledgerBase || !ledgerTokenResolved) return;
    if (state.loadingMore || !state.hasMore || !state.nextCursor) return;
    if (state.calls.length >= AGENT_CALLS_DISPLAY_CAP) return;
    const id = ++requestId.current;
    const cursor = state.nextCursor;
    setState((prev) => ({ ...prev, loadingMore: true, loadMoreError: null }));
    const { from, to } = usageWindowRange(usageWindow, nowRef.current());
    void (async () => {
      const result = await fetchCalls(ledgerBase, ledgerToken, {
        limit: AGENT_CALLS_PAGE_SIZE,
        cursor,
        agentId: [agentId],
        from,
        to,
      });
      if (requestId.current !== id) return;
      if (result.kind !== 'ok') {
        // The client has no dedicated "invalid cursor" result kind: a `400` surfaces as a generic `'error'` with
        // the status in its message. Recovering by reloading page 1 is safer than leaving a dead "Load more".
        if (result.kind === 'error' && result.message.includes('400')) {
          fetchFirstPage();
          return;
        }
        const message = result.kind === 'error' ? result.message : `The server answered "${result.kind}".`;
        setState((prev) => ({ ...prev, loadingMore: false, loadMoreError: message }));
        return;
      }
      setState((prev) => {
        // De-duplicates by `eventId`: a page that repeats a call already shown (a concurrent first-page refresh,
        // for example) is never appended twice.
        const seen = new Set(prev.calls.map((call) => call.eventId));
        const appended = result.data.data.filter((call) => !seen.has(call.eventId));
        return {
          query: prev.query,
          calls: [...prev.calls, ...appended],
          hasMore: result.data.page.hasMore,
          nextCursor: result.data.page.nextCursor,
          loadingMore: false,
          loadMoreError: null,
        };
      });
    })();
  }, [
    ledgerBase,
    ledgerToken,
    ledgerTokenResolved,
    state.loadingMore,
    state.hasMore,
    state.nextCursor,
    state.calls.length,
    agentId,
    usageWindow,
    fetchFirstPage,
  ]);

  // ---- Refetch trigger: a new real llm.usage/llm.failed event for THIS agent, debounced and rate limited ----
  const seenEventIds = useRef<Set<string> | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const throttleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRefreshAt = useRef(0);

  useEffect(() => {
    if (!enabled || !ledgerBase) {
      seenEventIds.current = null;
      if (debounceTimer.current !== null) clearTimeout(debounceTimer.current);
      if (throttleTimer.current !== null) clearTimeout(throttleTimer.current);
      debounceTimer.current = null;
      throttleTimer.current = null;
      return;
    }

    if (seenEventIds.current === null) {
      // First time this modal session enters ledger mode for this agent: seed with what is already present so
      // the initial fetch above is never immediately followed by a redundant one.
      seenEventIds.current = new Set(events.filter((event) => isUsageOrFailedEventFor(event, agentId)).map((event) => event.id));
      return;
    }

    const seen = seenEventIds.current;
    const unseen = events.filter((event) => isUsageOrFailedEventFor(event, agentId) && !seen.has(event.id));
    if (unseen.length === 0) return;
    for (const event of unseen) seen.add(event.id);

    if (debounceTimer.current !== null) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      debounceTimer.current = null;
      const elapsed = nowRef.current() - lastRefreshAt.current;
      const fire = () => {
        lastRefreshAt.current = nowRef.current();
        fetchFirstPage();
      };
      if (elapsed >= REFRESH_MIN_INTERVAL_MS) {
        fire();
      } else {
        if (throttleTimer.current !== null) clearTimeout(throttleTimer.current);
        throttleTimer.current = setTimeout(() => {
          throttleTimer.current = null;
          fire();
        }, REFRESH_MIN_INTERVAL_MS - elapsed);
      }
    }, REFRESH_DEBOUNCE_MS);

    return () => {
      if (debounceTimer.current !== null) clearTimeout(debounceTimer.current);
    };
  }, [events, enabled, ledgerBase, agentId, fetchFirstPage]);

  // Clears any pending timer on unmount.
  useEffect(
    () => () => {
      if (debounceTimer.current !== null) clearTimeout(debounceTimer.current);
      if (throttleTimer.current !== null) clearTimeout(throttleTimer.current);
    },
    []
  );

  const atCap = state.calls.length >= AGENT_CALLS_DISPLAY_CAP;

  return {
    query: state.query,
    calls: state.calls,
    hasMore: state.hasMore && !atCap,
    atCap,
    loadingMore: state.loadingMore,
    loadMoreError: state.loadMoreError,
    loadMore,
    retry,
  };
}
