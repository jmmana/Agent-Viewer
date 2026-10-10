/**
 * `MeetingRoomModal` (issue #81): live mode never reads `tokensAccumulated`/`costAccumulated` and shows
 * "unknown" rather than `$0.000` for a meeting with no ledger rows yet; demo mode keeps the seeded figures
 * tagged "Simulated" and makes no request; the spend table lists every portal meeting plus any server-only row,
 * with no totals row, and never changes the active meeting.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MeetingRoomModal } from '../../src/components/MeetingRoomModal';
import { applyExternalEvent, type ApplyEventOptions } from '../../src/integrations/eventIngestion';
import { createLiveSimulationState, type SimulationState } from '../../src/engine/officeState';
import type { LedgerConnection } from '../../src/components/modelOps/useModelOpsLedger';
import { T0, makeEvent, meetingRequested, registered } from './fixtures';
import type { CanonicalEvent } from '../../src/lib/index';

const NOW = 1_900_000_000_000;
const OPTIONS: ApplyEventOptions = { now: NOW, narrate: false, overflowFloor: false, trackUsage: false };

function apply(state: SimulationState, events: CanonicalEvent[]) {
  for (const event of events) applyExternalEvent(state, event, OPTIONS);
  return state;
}

/** Ana and Bruno at their desks with an active meeting `m-1`. */
function stateWithActiveMeeting(): SimulationState {
  return apply(createLiveSimulationState(), [
    registered('ana', 'Ana Rivas', { roleTitle: 'Planner', workspace: 'leads_area' }, { at: T0 }),
    registered('bruno', 'Bruno Díaz', { roleTitle: 'Engineer', workspace: 'development' }, { at: T0 + 10 }),
    meetingRequested('ana', 'm-1', ['ana', 'bruno'], { at: T0 + 20 }),
    makeEvent('meeting.started', 'ana', { meetingId: 'm-1' }, { at: T0 + 30 }),
  ]);
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function rollupBody(groups: unknown[] = []) {
  return {
    schemaVersion: '1.0',
    asOf: { ledgerSeq: 1, lastRowReceivedAt: 1, generatedAt: Date.now() },
    coverage: { storage: 'memory', complete: true, droppedRows: 0, purgedThrough: null, backfilledRows: 0, legacyContractRows: 0 },
    groupsAreAdditive: true,
    groupCount: groups.length,
    truncated: false,
    groups,
    totals: {
      calls: { total: 0, succeeded: 0, failed: 0 },
      tokens: {
        input: { sum: null, reportedCalls: 0, unreportedCalls: 0 },
        output: { sum: null, reportedCalls: 0, unreportedCalls: 0 },
        cacheRead: { sum: null, reportedCalls: 0, unreportedCalls: 0 },
        cacheWrite: { sum: null, reportedCalls: 0, unreportedCalls: 0 },
        reasoning: { sum: null, reportedCalls: 0, unreportedCalls: 0 },
      },
      cost: { entries: [], unknownCostCalls: 0 },
      firstAt: null,
      lastAt: null,
    },
  };
}

function meetingGroup(meetingId: string, title: string | null) {
  return {
    key: { meetingId, ...(title ? { title } : {}) },
    attribution: { meeting: 'attributed' },
    calls: { total: 7, succeeded: 7, failed: 0 },
    tokens: {
      input: { sum: 500, reportedCalls: 7, unreportedCalls: 0 },
      output: { sum: 120, reportedCalls: 7, unreportedCalls: 0 },
      cacheRead: { sum: null, reportedCalls: 0, unreportedCalls: 0 },
      cacheWrite: { sum: null, reportedCalls: 0, unreportedCalls: 0 },
      reasoning: { sum: null, reportedCalls: 0, unreportedCalls: 0 },
    },
    cost: { entries: [{ currency: 'USD', costSource: 'provider-reported', sum: 0.03, calls: 7 }], unknownCostCalls: 0 },
    firstAt: null,
    lastAt: null,
  };
}

const READY: LedgerConnection = { baseUrl: 'https://server.example', token: 'tok', tokenResolved: true };

describe('MeetingRoomModal', () => {
  it('demo mode: keeps the seeded tokensAccumulated/costAccumulated, tagged Simulated, and makes no request', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const state = stateWithActiveMeeting();
    render(
      <MeetingRoomModal
        meetings={state.meetings}
        activeMeetingId={state.activeMeetingId}
        agents={state.agents}
        onSelectAgent={() => {}}
        locale="en"
        events={state.events}
        ledger={null}
      />
    );
    expect(screen.getByText('Simulated')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('live mode: a meeting with no ledger rows shows "unknown", never $0.000 or 0', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, rollupBody())));
    const state = stateWithActiveMeeting();
    render(
      <MeetingRoomModal
        meetings={state.meetings}
        activeMeetingId={state.activeMeetingId}
        agents={state.agents}
        onSelectAgent={() => {}}
        locale="en"
        events={state.events}
        ledger={READY}
      />
    );
    await screen.findAllByText('unknown');
    expect(screen.queryByText('$0.000')).toBeNull();
    expect(screen.queryByText(/^\$0\.00/)).toBeNull();
    vi.unstubAllGlobals();
  });

  it('live mode: the spend table lists the portal meeting and a server-only row, with no totals row', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, rollupBody([meetingGroup('m-1', 'Release review'), meetingGroup('server-only-1', 'Ghost meeting')])))
    );
    const state = stateWithActiveMeeting();
    render(
      <MeetingRoomModal
        meetings={state.meetings}
        activeMeetingId={state.activeMeetingId}
        agents={state.agents}
        onSelectAgent={() => {}}
        locale="en"
        events={state.events}
        ledger={READY}
      />
    );
    await screen.findByText('Ghost meeting');
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.queryByText(/^Total/)).toBeNull();
    // Still shows the active meeting's own transcript, i.e. selecting the table never changed it.
    expect(screen.getAllByText('m-1').length).toBeGreaterThan(0);
    vi.unstubAllGlobals();
  });
});
