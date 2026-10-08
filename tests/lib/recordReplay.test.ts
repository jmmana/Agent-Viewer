import { describe, expect, it } from 'vitest';
import {
  computeReplaySchedule,
  isRecordingSupported,
  type CanonicalEventInput,
  type OfficeEventInput,
} from '../../src/lib/index';
import { T0, makeEvent } from './fixtures';

const ids = (events: readonly OfficeEventInput[]) => events.map((event) => event.id);

describe('computeReplaySchedule', () => {
  const events = [
    makeEvent('agent.status.changed', 'ana', { status: 'CODING' }, { id: 'c', at: T0 + 11_000 }),
    makeEvent('agent.registered', 'ana', { name: 'Ana Rivas' }, { id: 'a', at: T0 }),
    makeEvent('agent.status.changed', 'ana', { status: 'DONE' }, { id: 'd', at: T0 + 12_000 }),
    makeEvent('agent.status.changed', 'ana', { status: 'THINKING' }, { id: 'b', at: T0 + 1_000 }),
  ];

  it('plays events in timestamp order with their original gaps', () => {
    const schedule = computeReplaySchedule(events, { maxGapMs: 60_000 });
    expect(ids(schedule.events)).toEqual(['a', 'b', 'c', 'd']);
    expect(schedule.offsets).toEqual([0, 1_000, 11_000, 12_000]);
    expect(schedule.durationMs).toBe(12_000 + 2_000);
  });

  it('divides the gaps by the speed and shortens long silences to maxGapMs', () => {
    const schedule = computeReplaySchedule(events, { speed: 2, maxGapMs: 4_000, tailMs: 500 });
    // Gaps: 1 s, 10 s (shortened to 4 s), 1 s, each divided by 2.
    expect(schedule.offsets).toEqual([0, 500, 2_500, 3_000]);
    expect(schedule.durationMs).toBe(3_500);
  });

  it('uses a 5 s maximum gap by default', () => {
    expect(computeReplaySchedule(events).offsets).toEqual([0, 1_000, 6_000, 7_000]);
  });

  it('keeps the input order for events with the same timestamp', () => {
    const tied = [
      makeEvent('agent.status.changed', 'ana', { status: 'CODING' }, { id: 'first', at: T0 }),
      makeEvent('agent.status.changed', 'ana', { status: 'TESTING' }, { id: 'second', at: T0 }),
      makeEvent('agent.status.changed', 'ana', { status: 'DONE' }, { id: 'third', at: T0 }),
    ];
    const schedule = computeReplaySchedule(tied);
    expect(ids(schedule.events)).toEqual(['first', 'second', 'third']);
    expect(schedule.offsets).toEqual([0, 0, 0]);
  });

  it('reads ISO timestamps', () => {
    const schedule = computeReplaySchedule([
      { id: 'late', type: 'agent.status.changed', timestamp: '2026-01-15T14:00:03.000Z', payload: {} } satisfies CanonicalEventInput,
      { id: 'early', type: 'agent.status.changed', timestamp: '2026-01-15T14:00:00.000Z', payload: {} } satisfies CanonicalEventInput,
    ]);
    expect(ids(schedule.events)).toEqual(['early', 'late']);
    expect(schedule.offsets).toEqual([0, 3_000]);
  });

  it('caps the video length with maxDurationMs', () => {
    const schedule = computeReplaySchedule(events, { maxGapMs: 60_000, maxDurationMs: 5_000 });
    expect(schedule.durationMs).toBe(5_000);
  });

  it('treats a zero or negative speed as a very slow replay instead of dividing by zero', () => {
    const schedule = computeReplaySchedule(events.slice(0, 2), { speed: 0, maxGapMs: 60_000 });
    expect(schedule.offsets.every(Number.isFinite)).toBe(true);
    expect(schedule.offsets[1]).toBeGreaterThan(0);
  });

  it('returns an empty schedule for no events', () => {
    expect(computeReplaySchedule([])).toEqual({ events: [], offsets: [], durationMs: 2_000 });
  });

  it('does not leave the input reordered', () => {
    const input = [...events];
    computeReplaySchedule(input);
    expect(ids(input)).toEqual(['c', 'a', 'd', 'b']);
  });
});

describe('isRecordingSupported', () => {
  it('reports no support in jsdom (no captureStream or MediaRecorder)', () => {
    expect(isRecordingSupported()).toBe(false);
  });
});
