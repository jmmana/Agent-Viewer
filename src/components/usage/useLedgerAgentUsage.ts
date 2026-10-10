/**
 * Fetches the `groupBy=agent` usage rollup for the office canvas badges and the top-bar total (issue #78),
 * mirroring `useModelOpsLedger`'s refetch rules (issue #79) rather than sharing code with it: that hook is
 * scoped to the Model Ops modal and only its own tabs, and changing it to serve a second, always-mounted
 * caller risks regressing already-shipped behavior for a modal that is tested on its own. The duplication here
 * is small and deliberate; `tests/lib/ledgerAgentUsage.test.tsx` covers it independently.
 *
 * Refetches on: mount, a window change, a new real `llm.usage`/`llm.failed` event id (debounced and rate
 * limited, same constants as Model Ops) and, for a rolling window (`lastHour`/`today`/`7d`), a 60 s tick while
 * the tab is visible, because `from` moves with the clock even without a new event. "All" never polls.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ViewerEvent } from '../../types/agent';
import { fetchRollup, type RollupResponse } from '../../integrations/ledgerClient';
import { isRollingWindow, usageWindowRange, type UsageWindowOption } from '../../integrations/usageWindow';
import type { LedgerConnection, QueryState } from '../modelOps/useModelOpsLedger';

const REFRESH_DEBOUNCE_MS = 1500;
const REFRESH_MIN_INTERVAL_MS = 5000;
const ROLLING_POLL_MS = 60_000;

function isUsageOrFailedEvent(event: ViewerEvent): boolean {
  return event.type === 'llm.usage' || event.type === 'llm.failed';
}

export interface UseLedgerAgentUsageOptions {
  /** `null` means demo mode: no fetch is ever made. */
  ledger: LedgerConnection | null;
  window: UsageWindowOption;
  events: ViewerEvent[];
  now?: () => number;
}

export interface UseLedgerAgentUsageResult {
  query: QueryState<RollupResponse>;
  retry: () => void;
}

export function useLedgerAgentUsage(options: UseLedgerAgentUsageOptions): UseLedgerAgentUsageResult {
  const { ledger, window: usageWindow, events } = options;
  const nowRef = useRef(options.now ?? Date.now);
  nowRef.current = options.now ?? Date.now;

  const [query, setQuery] = useState<QueryState<RollupResponse>>({ status: 'idle' });
  const [retryTick, setRetryTick] = useState(0);
  const requestId = useRef(0);

  const ledgerBase = ledger?.baseUrl;
  const ledgerToken = ledger?.token;
  const ledgerTokenResolved = ledger?.tokenResolved ?? false;

  const retry = useCallback(() => setRetryTick((tick) => tick + 1), []);

  const runFetch = useCallback(() => {
    if (!ledgerBase || !ledgerTokenResolved) return;
    const id = ++requestId.current;
    setQuery({ status: 'loading' });
    const { from, to } = usageWindowRange(usageWindow, nowRef.current());
    void (async () => {
      const result = await fetchRollup(ledgerBase, ledgerToken, { groupBy: ['agent'], from, to });
      if (requestId.current !== id) return;
      if (result.kind === 'ok') setQuery({ status: 'ready', data: result.data });
      else if (result.kind === 'unavailable') setQuery({ status: 'unavailable' });
      else if (result.kind === 'unauthorized') setQuery({ status: 'unauthorized' });
      else setQuery({ status: 'error', message: result.message });
    })();
  }, [ledgerBase, ledgerToken, ledgerTokenResolved, usageWindow]);

  // ---- Mount, window change, manual retry ----
  useEffect(() => {
    if (!ledgerBase) {
      setQuery({ status: 'idle' });
      return;
    }
    if (!ledgerTokenResolved) {
      setQuery({ status: 'loading' });
      return;
    }
    runFetch();
  }, [ledgerBase, ledgerTokenResolved, runFetch, retryTick]);

  // ---- Rolling-window clock poll while the tab is visible ----
  useEffect(() => {
    if (!ledgerBase || !isRollingWindow(usageWindow)) return;
    const tick = () => {
      if (document.visibilityState === 'visible') runFetch();
    };
    const interval = setInterval(tick, ROLLING_POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [ledgerBase, usageWindow, runFetch]);

  // ---- New usage/failed event trigger, debounced and rate limited ----
  const seenEventIds = useRef<Set<string> | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const throttleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRefreshAt = useRef(0);

  useEffect(() => {
    if (!ledgerBase) {
      seenEventIds.current = null;
      if (debounceTimer.current !== null) clearTimeout(debounceTimer.current);
      if (throttleTimer.current !== null) clearTimeout(throttleTimer.current);
      debounceTimer.current = null;
      throttleTimer.current = null;
      return;
    }

    if (seenEventIds.current === null) {
      // First time entering ledger mode: seed with everything already present so the initial fetch above is
      // never immediately followed by a redundant one.
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
        runFetch();
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
  }, [events, ledgerBase, runFetch]);

  useEffect(
    () => () => {
      if (debounceTimer.current !== null) clearTimeout(debounceTimer.current);
      if (throttleTimer.current !== null) clearTimeout(throttleTimer.current);
    },
    []
  );

  return { query, retry };
}
