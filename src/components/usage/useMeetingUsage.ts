/**
 * Fetches `GET /api/v1/usage/rollup?groupBy=meeting` (issue #80) for the Meetings panel (issue #81): one group
 * per meeting id the ledger has seen, plus an `unattributed` group for calls with no `meetingId` at all. No
 * `from`/`to` filter: the panel wants all retained history, same as the issue's own spec ("the portal sends no
 * filter"). Mirrors the debounce/throttle shape of `useModelOpsLedger` (`src/components/modelOps/`) so a burst of
 * `llm.usage` events during a live meeting does not cause one request per event.
 */
import { useEffect, useRef, useState } from 'react';
import type { ViewerEvent } from '../../types/agent';
import { fetchRollup, type LedgerResult, type RollupResponse } from '../../integrations/ledgerClient';
import type { LedgerConnection } from '../modelOps/useModelOpsLedger';

export type MeetingUsageState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; data: RollupResponse }
  | { status: 'unavailable' }
  | { status: 'unauthorized' }
  | { status: 'error'; message: string };

const REFRESH_DEBOUNCE_MS = 2000;
const REFRESH_MIN_INTERVAL_MS = 5000;
/** High enough that a truncated response would be unusual; unattributed/attributed groups still never drop. */
const MEETING_ROLLUP_LIMIT = 500;

function toState(result: LedgerResult<RollupResponse>): MeetingUsageState {
  if (result.kind === 'ok') return { status: 'ready', data: result.data };
  if (result.kind === 'unavailable') return { status: 'unavailable' };
  if (result.kind === 'unauthorized') return { status: 'unauthorized' };
  return { status: 'error', message: result.message };
}

function isMeetingSpendTrigger(event: ViewerEvent): boolean {
  return event.type === 'llm.usage' || event.type === 'meeting.ended' || event.type === 'meeting.cancelled';
}

export interface UseMeetingUsageOptions {
  /** `null` means demo mode: no fetch is ever made. */
  ledger: LedgerConnection | null;
  /** Fetches only while the Meetings tab is shown. */
  isOpen: boolean;
  events: ViewerEvent[];
  now?: () => number;
}

export function useMeetingUsage(options: UseMeetingUsageOptions): MeetingUsageState {
  const { ledger, isOpen, events } = options;
  const nowRef = useRef(options.now ?? Date.now);
  nowRef.current = options.now ?? Date.now;

  const [state, setState] = useState<MeetingUsageState>({ status: 'idle' });
  const requestId = useRef(0);
  const [retryTick, setRetryTick] = useState(0);

  const ledgerBase = ledger?.baseUrl;
  const ledgerToken = ledger?.token;
  const ledgerTokenResolved = ledger?.tokenResolved ?? false;

  useEffect(() => {
    if (!isOpen || !ledgerBase) {
      setState({ status: 'idle' });
      return;
    }
    if (!ledgerTokenResolved) {
      setState({ status: 'loading' });
      return;
    }
    let cancelled = false;
    const id = ++requestId.current;
    setState({ status: 'loading' });
    void (async () => {
      const result = await fetchRollup(ledgerBase, ledgerToken, {
        groupBy: ['meeting'],
        sort: 'calls',
        limit: MEETING_ROLLUP_LIMIT,
      });
      if (cancelled || requestId.current !== id) return;
      setState(toState(result));
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, ledgerBase, ledgerToken, ledgerTokenResolved, retryTick]);

  // Debounced, rate-limited refetch on new llm.usage / meeting.ended / meeting.cancelled events.
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
      seenEventIds.current = new Set(events.filter(isMeetingSpendTrigger).map((event) => event.id));
      return;
    }
    const seen = seenEventIds.current;
    const unseen = events.filter((event) => isMeetingSpendTrigger(event) && !seen.has(event.id));
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
        throttleTimer.current = setTimeout(fire, REFRESH_MIN_INTERVAL_MS - elapsed);
      }
    }, REFRESH_DEBOUNCE_MS);

    return () => {
      if (debounceTimer.current !== null) clearTimeout(debounceTimer.current);
    };
  }, [events, isOpen, ledgerBase]);

  useEffect(
    () => () => {
      if (debounceTimer.current !== null) clearTimeout(debounceTimer.current);
      if (throttleTimer.current !== null) clearTimeout(throttleTimer.current);
    },
    []
  );

  return state;
}
