import { describe, expect, it } from 'vitest';
import { rebuildFromSnapshot, type LiveSnapshot } from '../../src/integrations/snapshotRebuild';
import { applyExternalEvent, type ExternalEventEnvelope } from '../../src/integrations/eventIngestion';
import { createLiveSimulationState } from '../../src/engine/officeState';
import { llmUsage, messageSent, registered, T0 } from './fixtures';

const NOW = 1_900_000_000_000;

/**
 * A snapshot whose `agents[]` totals (500 input tokens) are far larger than what its own `events` (one `llm.usage`
 * of 7 tokens) would sum to. This is the point of issue #54: a host that rebuilt totals by re-adding the
 * snapshot's 100 events would show a far lower total than the server actually holds.
 */
function sampleSnapshot(overrides: Partial<LiveSnapshot> = {}): LiveSnapshot {
  const events = [
    llmUsage('ana', { provider: 'acme', model: 'm', inputTokens: 5, outputTokens: 2, cost: 0.01 }, { id: 'evt-3', at: T0 + 20 }),
    messageSent('ana', 'Shipping the release notes.', {}, { id: 'evt-2', at: T0 + 10 }),
    registered('ana', 'Ana Rivas', { roleTitle: 'Planner', workspace: 'leads_area' }, { id: 'evt-1', at: T0 }),
  ];
  return {
    lastEventId: 'evt-3',
    events,
    agents: [
      { id: 'ana', tokensInput: 500, tokensOutput: 50, cachedTokens: 3, reasoningTokens: 1, cost: 1.23 },
      // Listed in the snapshot's usage but its own agent.registered event fell outside the 100 most recent events.
      { id: 'ghost', tokensInput: 10, tokensOutput: 1, cachedTokens: 0, reasoningTokens: 0, cost: null },
    ],
    totalTokens: { input: 510, output: 51, cached: 3, reasoning: 1 },
    totalCost: 1.24,
    ...overrides,
  };
}

describe('rebuildFromSnapshot', () => {
  it('matches applying the snapshot events oldest-first with trackUsage: false, then sets agent and total figures from the snapshot, never from summing the events', () => {
    const snapshot = sampleSnapshot();
    const state = rebuildFromSnapshot(snapshot, { locale: 'en', now: NOW });

    // The office itself (agents, statuses, messages) comes from replaying the events, oldest first.
    const expectedOffice = createLiveSimulationState();
    for (const event of [...snapshot.events].reverse()) {
      applyExternalEvent(expectedOffice, event as ExternalEventEnvelope, { now: NOW, locale: 'en', trackUsage: false });
    }
    const ana = state.agents.find((a) => a.id === 'ana')!;
    const expectedAna = expectedOffice.agents.find((a) => a.id === 'ana')!;
    expect(ana.name).toBe(expectedAna.name);
    expect(ana.roleTitle).toBe(expectedAna.roleTitle);
    expect(state.events.map((e) => e.id).sort()).toEqual(expectedOffice.events.map((e) => e.id).sort());

    // Usage figures are copied from the snapshot's own aggregates, never re-added from the replayed events: the
    // single llm.usage event here reports 5/2 tokens, but the snapshot's own agents[] and totals say otherwise.
    expect(ana.tokensInput).toBe(500);
    expect(ana.tokensOutput).toBe(50);
    expect(ana.cachedTokens).toBe(3);
    expect(ana.reasoningTokens).toBe(1);
    expect(ana.cost).toBe(1.23);
    expect(state.totalTokens).toEqual({ input: 510, output: 51, cached: 3, reasoning: 1 });
    expect(state.totalCost).toBe(1.24);
  });

  it('seeds a default profile for an agent the snapshot lists whose agent.registered event fell outside the replayed events', () => {
    const snapshot = sampleSnapshot();
    const state = rebuildFromSnapshot(snapshot, { locale: 'en', now: NOW });

    const ghost = state.agents.find((a) => a.id === 'ghost');
    expect(ghost).toBeDefined();
    expect(ghost!.tokensInput).toBe(10);
    expect(ghost!.tokensOutput).toBe(1);
    // A null legacy cost (mixed currencies, or no calls) is never dropped: the deprecated field is 0, matching
    // the convention eventIngestion.ts already uses for this field.
    expect(ghost!.cost).toBe(0);
  });

  it('treats a missing totalCost the same way (0), but keeps a real snapshot cost of 0 as 0', () => {
    const noCost = rebuildFromSnapshot(sampleSnapshot({ totalCost: null }), { now: NOW });
    expect(noCost.totalCost).toBe(0);

    const zeroCost = rebuildFromSnapshot(sampleSnapshot({ totalCost: 0 }), { now: NOW });
    expect(zeroCost.totalCost).toBe(0);
  });

  it('a live event applied after the rebuild adds to the server total once, starting from the snapshot totals, not from zero', () => {
    const snapshot = sampleSnapshot();
    const state = rebuildFromSnapshot(snapshot, { locale: 'en', now: NOW });

    const liveEvent = llmUsage('ana', { provider: 'acme', model: 'm', inputTokens: 9, outputTokens: 4, cost: 0.02 }, { id: 'evt-live', at: T0 + 30 });
    applyExternalEvent(state, liveEvent, { now: NOW, locale: 'en' });

    expect(state.totalTokens.input).toBe(510 + 9);
    expect(state.totalTokens.output).toBe(51 + 4);
    expect(state.totalCost).toBeCloseTo(1.24 + 0.02, 10);

    const ana = state.agents.find((a) => a.id === 'ana')!;
    expect(ana.tokensInput).toBe(500 + 9);
    expect(ana.tokensOutput).toBe(50 + 4);
  });
});
