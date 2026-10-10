/**
 * Owns every fetch the ledger-backed Model Ops tabs need (issue #79): the three rollups behind the Matrix and
 * Agents tabs and the paginated calls behind the Feed tab, all sharing one `from`/`to` window per refresh so no
 * provider or total figure is ever computed by summing rows in the browser (the server's own `totals` field,
 * present on every rollup response regardless of `groupBy`, is what the stats strip reads).
 *
 * Adaptation from the issue's own illustrative text: it describes four parallel rollup requests including one
 * with no `groupBy` "for the totals row". The shipped server (#66) makes `groupBy` mandatory (1 to 3 dimensions)
 * and always returns `totals` alongside `groups` for whatever dimensions were requested, so a dedicated
 * totals-only request would just repeat the same number the Matrix's own `groupBy=provider,model` call already
 * carries. This hook fetches three rollups (`provider,model`, `provider`, `agent,model`) instead of four, reusing
 * the first one's `totals` for the top stats strip.
 *
 * Only `src/components/modelOps/*` use this hook: see `tests/lib/libraryIsolation.test.ts`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ViewerEvent } from '../../types/agent';
import {
  fetchCalls,
  fetchRollup,
  FAILED_CALL_STATUSES,
  type CallRecord,
  type LedgerResult,
  type RollupDimension,
  type RollupResponse,
} from '../../integrations/ledgerClient';

export interface LedgerConnection {
  baseUrl: string;
  /** `undefined` while the token is still resolving (URL fragment, launch code or `sessionStorage`, all async). */
  token?: string;
  /** `false` while the token is still resolving: every query stays `'loading'` instead of risking a real 401
   * being read as "unauthorized" before the token had a chance to reach the request. */
  tokenResolved: boolean;
}

export type ModelOpsMode = 'ledger' | 'simulated';

export type QueryState<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'unavailable' }
  | { status: 'unauthorized' }
  | { status: 'error'; message: string };

export type TimeRangeOption = 'all' | '24h' | '7d';

export interface FeedFilters {
  status: 'all' | 'failed';
  model: string | null;
  agentId: string | null;
}

export const DEFAULT_FEED_FILTERS: FeedFilters = { status: 'all', model: null, agentId: null };

export interface FeedState {
  /** Status of the most recent first-page fetch; `loadMore` has its own `loadingMore`/`loadMoreError`. */
  query: QueryState<null>;
  calls: CallRecord[];
  hasMore: boolean;
  nextCursor: string | null;
  loadingMore: boolean;
  loadMoreError: string | null;
}

const INITIAL_FEED_STATE: FeedState = {
  query: { status: 'idle' },
  calls: [],
  hasMore: false,
  nextCursor: null,
  loadingMore: false,
  loadMoreError: null,
};

export const FEED_PAGE_SIZE = 50;
export const REFRESH_DEBOUNCE_MS = 1500;
export const REFRESH_MIN_INTERVAL_MS = 5000;

function timeRangeFrom(option: TimeRangeOption, now: number): number | undefined {
  if (option === 'all') return undefined;
  const windowMs = option === '24h' ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  return now - windowMs;
}

function toQueryState<T>(result: LedgerResult<T>): QueryState<T> {
  if (result.kind === 'ok') return { status: 'ready', data: result.data };
  if (result.kind === 'unavailable') return { status: 'unavailable' };
  if (result.kind === 'unauthorized') return { status: 'unauthorized' };
  return { status: 'error', message: result.message };
}

function isUsageOrFailedEvent(event: ViewerEvent): boolean {
  return event.type === 'llm.usage' || event.type === 'llm.failed';
}

export interface UseModelOpsLedgerOptions {
  /** `null` means "simulated" mode: no fetch is ever made. */
  ledger: LedgerConnection | null;
  /** Fetches only while the modal is open. */
  isOpen: boolean;
  /** Watched for new, real `llm.usage`/`llm.failed` ids to trigger a debounced refetch. Simulated calls never
   * reach this array (issue #57's isolation keeps them out of `events` entirely), so every id seen here is real. */
  events: ViewerEvent[];
  /** Injectable clock for tests. Defaults to `Date.now`. */
  now?: () => number;
}

export interface UseModelOpsLedgerResult {
  mode: ModelOpsMode;
  timeRange: TimeRangeOption;
  setTimeRange: (option: TimeRangeOption) => void;
  /** `groupBy=provider,model`: the Matrix tab's model cards, and the stats strip's `totals`. */
  modelRollup: QueryState<RollupResponse>;
  /** `groupBy=provider`: the Matrix tab's provider cards. */
  providerRollup: QueryState<RollupResponse>;
  /** `groupBy=agent,model`: the Agents tab's rows. */
  agentRollup: QueryState<RollupResponse>;
  feed: FeedState;
  feedFilters: FeedFilters;
  setFeedFilters: (filters: FeedFilters) => void;
  loadMoreFeed: () => void;
  /** Manual retry: re-runs every rollup and the feed's first page. */
  retry: () => void;
}

export function useModelOpsLedger(options: UseModelOpsLedgerOptions): UseModelOpsLedgerResult {
  const { ledger, isOpen, events } = options;
  // Kept in a ref, not a dependency: a caller that passes an inline `now` (every test, and any component that
  // does not memoize it) would otherwise give every effect below a new function identity on every render, and
  // an effect that itself sets state would then re-run forever instead of only on the inputs it actually cares
  // about (`isOpen`, `timeRange`, `retryTick`, ...).
  const nowRef = useRef(options.now ?? Date.now);
  nowRef.current = options.now ?? Date.now;

  const [timeRange, setTimeRange] = useState<TimeRangeOption>('all');
  const [feedFilters, setFeedFiltersState] = useState<FeedFilters>(DEFAULT_FEED_FILTERS);
  const [retryTick, setRetryTick] = useState(0);

  const [modelRollup, setModelRollup] = useState<QueryState<RollupResponse>>({ status: 'idle' });
  const [providerRollup, setProviderRollup] = useState<QueryState<RollupResponse>>({ status: 'idle' });
  const [agentRollup, setAgentRollup] = useState<QueryState<RollupResponse>>({ status: 'idle' });
  const [feed, setFeed] = useState<FeedState>(INITIAL_FEED_STATE);

  const rollupRequestId = useRef(0);
  const feedRequestId = useRef(0);

  const ledgerBase = ledger?.baseUrl;
  const ledgerToken = ledger?.token;
  const ledgerTokenResolved = ledger?.tokenResolved ?? false;

  const setFeedFilters = useCallback((filters: FeedFilters) => setFeedFiltersState(filters), []);
  const retry = useCallback(() => setRetryTick((tick) => tick + 1), []);

  // ---- Rollups: Matrix (provider,model / provider) and Agents (agent,model), one shared from/to per cycle ----
  useEffect(() => {
    if (!isOpen || !ledgerBase) {
      setModelRollup({ status: 'idle' });
      setProviderRollup({ status: 'idle' });
      setAgentRollup({ status: 'idle' });
      return;
    }
    if (!ledgerTokenResolved) {
      setModelRollup({ status: 'loading' });
      setProviderRollup({ status: 'loading' });
      setAgentRollup({ status: 'loading' });
      return;
    }

    let cancelled = false;
    const requestId = ++rollupRequestId.current;
    const to = nowRef.current();
    const from = timeRangeFrom(timeRange, to);

    setModelRollup({ status: 'loading' });
    setProviderRollup({ status: 'loading' });
    setAgentRollup({ status: 'loading' });

    const run = async (groupBy: RollupDimension[], setState: (state: QueryState<RollupResponse>) => void) => {
      const result = await fetchRollup(ledgerBase, ledgerToken, { groupBy, from, to });
      if (cancelled || rollupRequestId.current !== requestId) return;
      setState(toQueryState(result));
    };

    void run(['provider', 'model'], setModelRollup);
    void run(['provider'], setProviderRollup);
    void run(['agent', 'model'], setAgentRollup);

    return () => {
      cancelled = true;
    };
  }, [isOpen, ledgerBase, ledgerToken, ledgerTokenResolved, timeRange, retryTick]);

  // ---- Feed: first page, refetched on open, on filter change, on manual retry and on the new-event trigger ----
  const fetchFeedFirstPage = useCallback(() => {
    if (!ledgerBase || !ledgerTokenResolved) return;
    const requestId = ++feedRequestId.current;
    setFeed((prev) => ({ ...prev, query: { status: 'loading' } }));
    void (async () => {
      const result = await fetchCalls(ledgerBase, ledgerToken, {
        limit: FEED_PAGE_SIZE,
        status: feedFilters.status === 'failed' ? [...FAILED_CALL_STATUSES] : undefined,
        model: feedFilters.model ? [feedFilters.model] : undefined,
        agentId: feedFilters.agentId ? [feedFilters.agentId] : undefined,
      });
      if (feedRequestId.current !== requestId) return;
      if (result.kind !== 'ok') {
        setFeed({ ...INITIAL_FEED_STATE, query: toQueryState(result) as QueryState<null> });
        return;
      }
      setFeed({
        query: { status: 'ready', data: null },
        calls: result.data.data,
        hasMore: result.data.page.hasMore,
        nextCursor: result.data.page.nextCursor,
        loadingMore: false,
        loadMoreError: null,
      });
    })();
  }, [ledgerBase, ledgerToken, ledgerTokenResolved, feedFilters.status, feedFilters.model, feedFilters.agentId]);

  useEffect(() => {
    if (!isOpen || !ledgerBase) {
      setFeed(INITIAL_FEED_STATE);
      return;
    }
    if (!ledgerTokenResolved) {
      setFeed((prev) => ({ ...prev, query: { status: 'loading' } }));
      return;
    }
    fetchFeedFirstPage();
  }, [isOpen, ledgerBase, ledgerTokenResolved, fetchFeedFirstPage, retryTick]);

  const loadMoreFeed = useCallback(() => {
    if (!ledgerBase || !ledgerTokenResolved) return;
    if (feed.loadingMore || !feed.hasMore || !feed.nextCursor) return;
    const requestId = ++feedRequestId.current;
    const cursor = feed.nextCursor;
    setFeed((prev) => ({ ...prev, loadingMore: true, loadMoreError: null }));
    void (async () => {
      const result = await fetchCalls(ledgerBase, ledgerToken, {
        limit: FEED_PAGE_SIZE,
        cursor,
        status: feedFilters.status === 'failed' ? [...FAILED_CALL_STATUSES] : undefined,
        model: feedFilters.model ? [feedFilters.model] : undefined,
        agentId: feedFilters.agentId ? [feedFilters.agentId] : undefined,
      });
      if (feedRequestId.current !== requestId) return;
      if (result.kind !== 'ok') {
        const message = result.kind === 'error' ? result.message : `The server answered "${result.kind}".`;
        setFeed((prev) => ({ ...prev, loadingMore: false, loadMoreError: message }));
        return;
      }
      setFeed((prev) => {
        // De-duplicates by id: a page that returns a call already shown (for example after a concurrent
        // refresh) is never appended twice.
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
  }, [ledgerBase, ledgerToken, ledgerTokenResolved, feed.loadingMore, feed.hasMore, feed.nextCursor, feedFilters]);

  // ---- Refetch trigger: a new, real llm.usage/llm.failed event id, debounced and rate-limited ----
  const seenEventIds = useRef<Set<string> | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const throttleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRefreshAt = useRef(0);

  useEffect(() => {
    if (!isOpen || !ledgerBase) {
      seenEventIds.current = null;
      if (debounceTimer.current !== null) clearTimeout(debounceTimer.current);
      if (throttleTimer.current !== null) clearTimeout(throttleTimer.current);
      debounceTimer.current = null;
      throttleTimer.current = null;
      return;
    }

    if (seenEventIds.current === null) {
      // First time this modal session enters ledger mode: seed with everything already present, so events the
      // initial fetch above already covers never trigger an immediate, redundant refetch.
      seenEventIds.current = new Set(events.filter(isUsageOrFailedEvent).map((event) => event.id));
      return;
    }

    const seen = seenEventIds.current;
    const unseen = events.filter((event) => isUsageOrFailedEvent(event) && !seen.has(event.id));
    if (unseen.length === 0) return;
    for (const event of unseen) seen.add(event.id);

    if (debounceTimer.current !== null) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      debounceTimer.current = null;
      const elapsed = nowRef.current() - lastRefreshAt.current;
      const fire = () => {
        lastRefreshAt.current = nowRef.current();
        setRetryTick((tick) => tick + 1);
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
  }, [events, isOpen, ledgerBase]);

  // Clears any pending timer on unmount.
  useEffect(
    () => () => {
      if (debounceTimer.current !== null) clearTimeout(debounceTimer.current);
      if (throttleTimer.current !== null) clearTimeout(throttleTimer.current);
    },
    []
  );

  return {
    mode: ledger ? 'ledger' : 'simulated',
    timeRange,
    setTimeRange,
    modelRollup,
    providerRollup,
    agentRollup,
    feed,
    feedFilters,
    setFeedFilters,
    loadMoreFeed,
    retry,
  };
}
