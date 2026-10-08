import { describe, expect, it } from 'vitest';
import { OfficeStore, buildOfficeSnapshot, type OfficeEventInput, type OfficeSnapshot } from '../../src/lib/index';
import { DEFAULT_BUBBLE_MS } from '../../src/integrations/eventIngestion';
import { T0, meetingMessage, meetingRequested, messageSent, registered } from './fixtures';

/** Wall clock of the tests, unrelated to the event times on purpose. */
const NOW = 1_900_000_000_000;

function agent(snapshot: OfficeSnapshot, id: string) {
  const found = snapshot.agents.find((item) => item.id === id);
  if (!found) throw new Error(`Agent ${id} is not in the snapshot`);
  return found;
}

const pair: OfficeEventInput[] = [
  registered('ana', 'Ana Rivas', { roleTitle: 'Planner', workspace: 'leads_area' }, { at: T0 }),
  registered('bruno', 'Bruno Díaz', { roleTitle: 'Engineer', workspace: 'development' }, { at: T0 + 500 }),
];

describe('Professional mode shows only what the events say', () => {
  const withMeeting: OfficeEventInput[] = [
    ...pair,
    meetingRequested('ana', 'design-review', ['ana', 'bruno'], { at: T0 + 1000 }),
  ];

  it('does not invent bubbles, calls or a second floor for a meeting request', () => {
    const snapshot = buildOfficeSnapshot(withMeeting, { mode: 'professional', now: NOW });

    expect(snapshot.agents.map((item) => item.id).sort()).toEqual(['ana', 'bruno']);
    for (const item of snapshot.agents) {
      expect(item.speechBubble).toBeNull();
      expect(item.ambientBubble).toBeNull();
      expect(item.floor ?? 1).toBe(1);
      expect(item.status).not.toBe('PHONE_CALL');
      expect(item.statusText).toBe('');
    }
    expect(snapshot.meetings).toHaveLength(1);
    expect(snapshot.meetings[0].messages).toEqual([]);
  });

  it('narrates the meeting request in showcase mode', () => {
    const snapshot = buildOfficeSnapshot(withMeeting, { mode: 'showcase', now: NOW });

    for (const item of snapshot.agents) {
      expect(item.status).toBe('PHONE_CALL');
      expect(item.speechBubble?.text).toBeTruthy();
      expect(item.speechBubble!.expiresAt).toBeGreaterThan(NOW);
    }
  });

  it('never moves a meeting to the hidden floor when every visible room is busy', () => {
    const ids = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'];
    const events: OfficeEventInput[] = [
      ...ids.map((id, index) => registered(id, `Agent ${index + 1}`, {}, { at: T0 + index })),
      meetingRequested('a1', 'm-1', ['a1', 'a2'], { at: T0 + 100 }),
      meetingRequested('a3', 'm-2', ['a3', 'a4'], { at: T0 + 200 }),
      meetingRequested('a5', 'm-3', ['a5', 'a6'], { at: T0 + 300 }),
      meetingRequested('a7', 'm-4', ['a7', 'a8'], { at: T0 + 400 }),
    ];
    const store = new OfficeStore({ mode: 'professional' });
    store.sync(events, undefined, NOW);
    store.tick(NOW + 60_000);
    const snapshot = store.snapshot();

    // `snapshot()` drops agents that are not on floor 1, so the count proves nobody went upstairs.
    expect(snapshot.agents).toHaveLength(ids.length);
    for (const item of snapshot.agents) {
      expect(item.floor ?? 1).toBe(1);
      expect(item.workspace).not.toBe('overflow_floor');
      expect(item.speechBubble).toBeNull();
    }
    expect(snapshot.meetings.map((meeting) => meeting.roomId).filter(Boolean).sort()).toEqual([
      'boss_office',
      'meeting_room',
      'meeting_room_b',
    ]);
  });

  it('has no coffee breaks or ambient chats however long the office runs', () => {
    const store = new OfficeStore({ mode: 'professional' });
    store.sync(pair, undefined, NOW);
    for (const later of [1_000, 13_000, 20_000, 60_000, 10 * 60_000, 60 * 60_000]) {
      store.tick(NOW + later);
    }
    const snapshot = store.snapshot();

    for (const item of snapshot.agents) {
      expect(item.ambientBubble).toBeNull();
      expect(item.presentationActivity ?? null).toBeNull();
      expect(item.status).toBe('IDLE');
      expect(item.workspace).not.toBe('break_room');
      expect(item.socialActivityId ?? null).toBeNull();
    }
  });

  it('adds simulated ambient life in showcase mode (control)', () => {
    const store = new OfficeStore({ mode: 'showcase' });
    store.sync(pair, undefined, NOW);
    expect(store.tick(NOW + 1_000)).toBe(true);
    const snapshot = store.snapshot();

    expect(snapshot.agents.some((item) => item.ambientBubble?.text)).toBe(true);
    expect(snapshot.agents.every((item) => item.presentationActivity === 'chatting')).toBe(true);
  });
});

describe('OfficeStore: incremental updates and rebuilds', () => {
  const BUBBLE_MS = 5_000;
  const first = messageSent('ana', 'Starting the schema migration.', {}, { at: T0 + 1_000 });
  const second = messageSent('bruno', 'Tests are green on my side.', {}, { at: T0 + 2_000 });

  it('applies only the new events when the list grows', () => {
    const store = new OfficeStore({ bubbleMs: BUBBLE_MS });
    const initial = [...pair, first];

    expect(store.sync(initial, undefined, NOW)).toBe(true);
    expect(agent(store.snapshot(), 'ana').speechBubble?.expiresAt).toBe(NOW + BUBBLE_MS);

    // The same list again is a no-op.
    expect(store.sync([...initial], undefined, NOW + 500)).toBe(false);
    expect(agent(store.snapshot(), 'ana').speechBubble?.expiresAt).toBe(NOW + BUBBLE_MS);

    expect(store.sync([...initial, second], undefined, NOW + 1_000)).toBe(true);
    const snapshot = store.snapshot();
    // Ana's bubble was not applied a second time: it keeps its original expiry.
    expect(agent(snapshot, 'ana').speechBubble?.expiresAt).toBe(NOW + BUBBLE_MS);
    expect(agent(snapshot, 'bruno').speechBubble?.expiresAt).toBe(NOW + 1_000 + BUBBLE_MS);
  });

  it('rebuilds from scratch when the list gets shorter (seek back)', () => {
    const store = new OfficeStore({ bubbleMs: BUBBLE_MS });
    store.sync([...pair, first, second], undefined, NOW);

    store.sync(pair, undefined, NOW + 1_000);
    let snapshot = store.snapshot();
    expect(snapshot.agents).toHaveLength(2);
    expect(agent(snapshot, 'ana').speechBubble).toBeNull();
    expect(agent(snapshot, 'bruno').speechBubble).toBeNull();

    // Moving forward again applies the message with the new clock.
    store.sync([...pair, first], undefined, NOW + 2_000);
    snapshot = store.snapshot();
    expect(agent(snapshot, 'ana').speechBubble?.expiresAt).toBe(NOW + 2_000 + BUBBLE_MS);
  });

  it('rebuilds when a different run of the same length replaces the list', () => {
    const store = new OfficeStore({ bubbleMs: BUBBLE_MS });
    store.sync([...pair, first], undefined, NOW);

    const otherRun = [
      registered('carla', 'Carla Méndez', {}, { at: T0 }),
      registered('diego', 'Diego Paz', {}, { at: T0 }),
      messageSent('carla', 'Different run.', {}, { at: T0 + 10 }),
    ];
    expect(store.sync(otherRun, undefined, NOW + 100)).toBe(true);
    expect(store.snapshot().agents.map((item) => item.id).sort()).toEqual(['carla', 'diego']);
  });

  it('rebuilds when the mode changes', () => {
    const events = [...pair, meetingRequested('ana', 'm-1', ['ana', 'bruno'], { at: T0 + 1_000 })];
    const store = new OfficeStore({ mode: 'professional' });
    store.sync(events, undefined, NOW);
    expect(agent(store.snapshot(), 'ana').speechBubble).toBeNull();

    store.sync(events, undefined, NOW, { mode: 'showcase' });
    expect(agent(store.snapshot(), 'ana').status).toBe('PHONE_CALL');
  });

  it('keeps the relative timing of a batch of past events', () => {
    const store = new OfficeStore({ bubbleMs: DEFAULT_BUBBLE_MS });
    const events = [
      ...pair,
      messageSent('ana', 'This was said a minute earlier.', {}, { at: T0 + 10_000 }),
      messageSent('bruno', 'This is the latest message.', {}, { at: T0 + 70_000 }),
    ];
    store.sync(events, undefined, NOW);
    const snapshot = store.snapshot();

    const old = agent(snapshot, 'ana').speechBubble;
    const latest = agent(snapshot, 'bruno').speechBubble;
    expect(old?.expiresAt).toBe(NOW - 60_000 + DEFAULT_BUBBLE_MS);
    expect(old!.expiresAt).toBeLessThan(NOW);
    expect(latest?.expiresAt).toBe(NOW + DEFAULT_BUBBLE_MS);
    expect(latest!.expiresAt).toBeGreaterThan(NOW);
  });

  it('applies duplicated event ids once', () => {
    const message = meetingMessage('ana', 'm-1', 'One decision, sent twice by a retrying runtime.', 'decision', {
      id: 'evt-retry-1',
      at: T0 + 2_000,
    });
    const snapshot = buildOfficeSnapshot(
      [...pair, meetingRequested('ana', 'm-1', ['ana', 'bruno'], { at: T0 + 1_000 }), message, { ...message }],
      { now: NOW },
    );
    expect(snapshot.meetings[0].messages).toHaveLength(1);
    expect(snapshot.meetings[0].decisions).toEqual(['One decision, sent twice by a retrying runtime.']);
  });

  it('returns copies that cannot change the store', () => {
    const store = new OfficeStore();
    store.sync([...pair, first], undefined, NOW);
    const copy = agent(store.snapshot(), 'ana');
    copy.name = 'Changed by the host';
    copy.speechBubble!.text = 'Changed by the host';

    const fresh = store.snapshot();
    expect(fresh.agents.map((item) => item.name)).not.toContain('Changed by the host');
    expect(agent(fresh, 'ana').speechBubble?.text).toBe('Starting the schema migration.');
  });
});
