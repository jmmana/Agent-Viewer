/**
 * Fetches `GET /api/v1/usage/rollup?groupBy=tool` (issue #80), scoped to one agent (and optionally one task),
 * for the tool chip tooltips (issue #81). Lazy: nothing is fetched until `enabled` turns on (hover or focus on
 * the chip), and a 5 second cache keyed by `(agentId, taskId)` means moving the pointer on and off the same chip
 * repeatedly does not refetch every time.
 */
import { useEffect, useRef, useState } from 'react';
import { fetchRollup, type LedgerResult, type RollupResponse } from '../../integrations/ledgerClient';
import type { LedgerConnection } from '../modelOps/useModelOpsLedger';

export type ToolUsageState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; data: RollupResponse }
  | { status: 'unavailable' }
  | { status: 'unauthorized' }
  | { status: 'error'; message: string };

const CACHE_TTL_MS = 5000;

interface CacheEntry {
  at: number;
  state: ToolUsageState;
}

const cache = new Map<string, CacheEntry>();

function toState(result: LedgerResult<RollupResponse>): ToolUsageState {
  if (result.kind === 'ok') return { status: 'ready', data: result.data };
  if (result.kind === 'unavailable') return { status: 'unavailable' };
  if (result.kind === 'unauthorized') return { status: 'unauthorized' };
  return { status: 'error', message: result.message };
}

export interface UseToolUsageOptions {
  ledger: LedgerConnection | null;
  agentId: string;
  taskId?: string;
  /** Only fetches while `true` (the chip is hovered or focused). */
  enabled: boolean;
  now?: () => number;
}

export function useToolUsage(options: UseToolUsageOptions): ToolUsageState {
  const { ledger, agentId, taskId, enabled } = options;
  const nowRef = useRef(options.now ?? Date.now);
  nowRef.current = options.now ?? Date.now;

  const ledgerBase = ledger?.baseUrl;
  const ledgerToken = ledger?.token;
  const ledgerTokenResolved = ledger?.tokenResolved ?? false;
  const cacheKey = ledgerBase ? `${ledgerBase}\u0000${agentId}\u0000${taskId ?? ''}` : null;

  const [state, setState] = useState<ToolUsageState>({ status: 'idle' });
  const requestId = useRef(0);

  useEffect(() => {
    if (!enabled || !ledgerBase || !cacheKey) {
      setState({ status: 'idle' });
      return;
    }
    if (!ledgerTokenResolved) {
      setState({ status: 'loading' });
      return;
    }
    const cached = cache.get(cacheKey);
    if (cached && nowRef.current() - cached.at < CACHE_TTL_MS) {
      setState(cached.state);
      return;
    }
    let cancelled = false;
    const id = ++requestId.current;
    setState({ status: 'loading' });
    void (async () => {
      const result = await fetchRollup(ledgerBase, ledgerToken, {
        groupBy: ['tool'],
        agentId: [agentId],
        taskId: taskId ? [taskId] : undefined,
        sort: 'calls',
        limit: 200,
      });
      if (cancelled || requestId.current !== id) return;
      const next = toState(result);
      cache.set(cacheKey, { at: nowRef.current(), state: next });
      setState(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, ledgerBase, ledgerToken, ledgerTokenResolved, agentId, taskId, cacheKey]);

  return state;
}
