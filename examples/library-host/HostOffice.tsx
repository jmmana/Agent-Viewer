/**
 * Worked example host (issue #260): fetches the server's usage rollup and recent calls through the local
 * proxy (`proxy.ts`), maps them with the pure functions in `usageFromRollup.ts`, and renders `<AgentOffice>`
 * with real spend figures. This is the whole integration an app embedding `@warlockcode/agent-viewer` needs
 * for server-backed spend: fetch, map, pass as props. The component itself never fetches or computes.
 */
import React, { useEffect, useRef, useState } from 'react';
// Imported from the repository source so this example type-checks against the real declarations in CI.
// In your own app: import { AgentOffice } from '@warlockcode/agent-viewer';
import { AgentOffice } from '../../src/lib/index';
import type { OfficeUsage } from '../../src/lib/usage';
import type { AgentCallDetails } from '../../src/lib/callDetails';
import { rollupToUsage, callsToDetail, type RollupResponse, type CallsResponse } from './usageFromRollup';

const POLL_MS = 15_000;

/**
 * The agent roster this example renders. A real host reads its own roster (its database, its config); the
 * point here is server-backed usage, not agent discovery. `writer` is listed but never appears in `seed.sh`,
 * on purpose: it demonstrates an agent absent from the rollup, which must render "unknown", never a stale or
 * invented figure.
 */
const AGENTS = [
  { id: 'builder', name: 'Builder' },
  { id: 'planner', name: 'Planner' },
  { id: 'researcher', name: 'Researcher' },
  { id: 'qa', name: 'QA' },
  { id: 'writer', name: 'Writer' },
];

interface UsageState {
  usage: OfficeUsage | undefined;
  details: AgentCallDetails | undefined;
  error: string | null;
}

async function fetchUsage(signal: AbortSignal): Promise<Omit<UsageState, 'error'>> {
  const [rollupRes, callsRes] = await Promise.all([
    fetch('/api/v1/usage/rollup?groupBy=agent', { signal }),
    fetch('/api/v1/usage/calls?limit=50', { signal }),
  ]);
  if (!rollupRes.ok || !callsRes.ok) {
    throw new Error(`server answered ${rollupRes.status} (rollup) / ${callsRes.status} (calls)`);
  }
  const rollup = (await rollupRes.json()) as RollupResponse;
  const calls = (await callsRes.json()) as CallsResponse;
  return { usage: rollupToUsage(rollup), details: callsToDetail(calls) };
}

export function HostOffice(): React.JSX.Element {
  const [state, setState] = useState<UsageState>({ usage: undefined, details: undefined, error: null });
  // Tracks the in-flight request so a slow response from a previous poll can never land after a newer one.
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let unmounted = false;

    async function poll(): Promise<void> {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      try {
        const result = await fetchUsage(controller.signal);
        if (unmounted || controller.signal.aborted) return;
        setState({ ...result, error: null });
      } catch (error) {
        if (unmounted || controller.signal.aborted) return;
        // A failed fetch clears the figures instead of keeping the last good ones: every badge then reads
        // "unknown", never a number that may no longer be true.
        setState({
          usage: undefined,
          details: undefined,
          error: error instanceof Error ? error.message : 'request failed',
        });
      }
    }

    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      unmounted = true;
      clearInterval(timer);
      controllerRef.current?.abort();
    };
  }, []);

  return (
    <div className="library-host-page">
      {state.error !== null && (
        <p role="alert" className="library-host-error">
          Could not reach the server: {state.error}. Figures below read &quot;unknown&quot; until the next retry.
        </p>
      )}
      <AgentOffice
        agents={AGENTS}
        showUsage
        showUsageBadges
        usage={state.usage}
        showCallDetails
        agentCallDetails={state.details}
      />
    </div>
  );
}
