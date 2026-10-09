/**
 * Rebuilds the live office from a server snapshot (issue #54): the host's answer to an SSE `resync`, and the
 * same path a fresh load can use before the stream ever connects.
 *
 * The rule this module exists for: after a resync, usage figures come from the server's own aggregates, never
 * from re-adding the snapshot's events. `GET /api/v1/snapshot` carries only the newest 100 events, so a host
 * that rebuilt totals by summing them again would show far less usage than really happened. The events are
 * still applied, with usage tracking off, so the office, agent statuses, tasks and meetings come back; the
 * token and cost figures are copied from the snapshot's own totals afterward, as received.
 */
import type { SimulationState } from '../engine/officeState';
import { createLiveSimulationState } from '../engine/officeState';
import { applyExternalEvent, createDefaultAgent, type ExternalEventEnvelope } from './eventIngestion';
import { validateExternalEvent } from './eventValidation';

/**
 * The deprecated per-agent legacy usage fields of `GET /api/v1/snapshot`'s `agents[]` (`AgentRecord` on the
 * server). `cost` is `null` unless every call of the agent reported one in a single currency and cost source.
 */
export interface SnapshotAgentUsage {
  id: string;
  tokensInput: number;
  tokensOutput: number;
  cachedTokens: number;
  reasoningTokens: number;
  cost: number | null;
}

/** The subset of `GET /api/v1/snapshot` a host needs to rebuild the office after a resync (issue #54). */
export interface LiveSnapshot {
  /** Newest stored event id, or `null` when the store is empty. The cursor to resume the stream from. */
  lastEventId: string | null;
  /** Newest 100 events only, newest first, exactly as the server returns them: rebuilds the office, not the totals. */
  events: unknown[];
  agents: SnapshotAgentUsage[];
  /** Deprecated legacy totals: sums of reported values only, a lower bound when some call did not report them. */
  totalTokens: { input: number; output: number; cached: number; reasoning: number };
  /** Null unless every call across every agent reported a cost in one single currency with one single costSource. */
  totalCost: number | null;
}

export interface RebuildFromSnapshotOptions {
  /** BCP 47 locale for the texts the office writes itself while replaying history. Defaults to English. */
  locale?: string;
  /** Clock for the replay. Defaults to `Date.now()`; tests pass their own for reproducible output. */
  now?: number;
}

/**
 * Builds a fresh `SimulationState` from a snapshot. Applies `snapshot.events` oldest first (the array itself is
 * newest first) with `trackUsage: false`, so agents, tasks and meetings come back without adding any usage.
 * Every agent `snapshot.agents` lists then gets its token and cost figures set from the server record as
 * received (never summed from the replayed events), and the state's own totals come from `snapshot.totalTokens`
 * and `snapshot.totalCost`. An agent the snapshot lists but whose `agent.registered` event fell outside the
 * snapshot's 100 most recent events is still seeded with a default profile, so its usage is never dropped.
 */
export function rebuildFromSnapshot(snapshot: LiveSnapshot, options: RebuildFromSnapshotOptions = {}): SimulationState {
  const state = createLiveSimulationState();
  const now = options.now ?? Date.now();

  const oldestFirst = [...snapshot.events].reverse();
  for (const raw of oldestFirst) {
    if (!validateExternalEvent(raw)) continue;
    applyExternalEvent(state, raw as ExternalEventEnvelope, { trackUsage: false, locale: options.locale, now });
  }

  for (const record of snapshot.agents) {
    let agent = state.agents.find((item) => item.id === record.id);
    if (!agent) {
      agent = createDefaultAgent(record.id, now);
      state.agents.push(agent);
    }
    agent.tokensInput = record.tokensInput;
    agent.tokensOutput = record.tokensOutput;
    agent.cachedTokens = record.cachedTokens;
    agent.reasoningTokens = record.reasoningTokens;
    // The legacy per-agent field is not nullable client-side; unknown (mixed currencies, no calls) is 0 here,
    // same convention eventIngestion.ts already uses for this deprecated field.
    agent.cost = record.cost ?? 0;
  }

  state.totalTokens = { ...snapshot.totalTokens };
  state.totalCost = snapshot.totalCost ?? 0;

  return state;
}
