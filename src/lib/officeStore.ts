import type { Agent, Meeting, ViewerEvent, WorkspaceZone } from '../types/agent';
import type { CanonicalEvent, CanonicalEventInput } from '../integrations/canonicalTypes';
import { createLiveSimulationState, type SimulationState } from '../engine/officeState';
import { advanceLivingOffice, applyAmbientLife } from '../engine/livingOfficeEngine';
import { applyExternalEvent, DEFAULT_BUBBLE_MS, type ApplyEventOptions } from '../integrations/eventIngestion';

/**
 * `professional`: only what the events say. No ambient life, no invented lines, no hidden floor.
 * `showcase`: adds the living office (coffee breaks and chats marked as simulated) for demos.
 */
export type OfficeMode = 'professional' | 'showcase';

/** Any event the office understands: canonical V1 events (fully normalized or as sent) or the legacy envelope. */
export type OfficeEventInput = CanonicalEvent | CanonicalEventInput | ViewerEvent;

/**
 * Identity of an agent known before its first event. Equivalent to an `agent.registered` event.
 * `workspace` is the room where the agent sits, `avatarColor` a hex color such as `#38bdf8`.
 */
export interface AgentProfile {
  id: string;
  name: string;
  roleTitle?: string;
  team?: Agent['team'];
  workspace?: WorkspaceZone;
  avatarColor?: string;
}

export interface OfficeStoreOptions {
  mode?: OfficeMode;
  /** How long a speech bubble stays visible, in milliseconds. */
  bubbleMs?: number;
  /** Language of the simulated social lines in showcase mode. */
  locale?: string;
}

export interface OfficeSnapshot {
  agents: Agent[];
  activeMeetingId: string | null;
  meetings: Meeting[];
}

type EventKey = string | object;

function eventKey(event: OfficeEventInput): EventKey {
  const id = (event as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : event;
}

function eventTimestamp(event: OfficeEventInput): number | null {
  const value = (event as { timestamp?: unknown }).timestamp;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function profileEvent(profile: AgentProfile): CanonicalEventInput {
  return {
    id: `profile:${profile.id}`,
    type: 'agent.registered',
    timestamp: 1,
    source: `agent:${profile.id}`,
    agentId: profile.id,
    summary: profile.name,
    payload: {
      name: profile.name,
      roleTitle: profile.roleTitle ?? '',
      team: profile.team,
      workspace: profile.workspace,
      avatarColor: profile.avatarColor,
    },
  };
}

function signature(state: SimulationState): string {
  return state.agents
    .map((agent) => [
      agent.id, agent.status, agent.workspace, agent.floor ?? 1, agent.isWalking ? 1 : 0,
      agent.x.toFixed(2), agent.y.toFixed(2), agent.presentationActivity ?? '',
      agent.speechBubble?.expiresAt ?? 0, agent.ambientBubble?.expiresAt ?? 0,
    ].join(':'))
    .join('|') + `#${state.activeMeetingId ?? ''}`;
}

/**
 * Derives the office from a list of events. One store per office instance: nothing is shared between
 * instances, and nothing is read from or written to browser storage.
 *
 * When the list only grows (live stream or a replay moving forward) the store applies the new events. Any
 * other change (seeking back, a different run, new profiles or a new mode) rebuilds the office from scratch.
 */
export class OfficeStore {
  private state: SimulationState = createLiveSimulationState();
  private applied = 0;
  private firstKey: EventKey | null = null;
  private lastKey: EventKey | null = null;
  private profiles: readonly AgentProfile[] | undefined;
  private mode: OfficeMode;
  private bubbleMs: number;
  private locale: string;

  constructor(options: OfficeStoreOptions = {}) {
    this.mode = options.mode ?? 'professional';
    this.bubbleMs = options.bubbleMs ?? DEFAULT_BUBBLE_MS;
    this.locale = options.locale ?? 'en';
  }

  /** Brings the office up to date with `events`. Returns true when something visible changed. */
  sync(
    events: readonly OfficeEventInput[],
    profiles: readonly AgentProfile[] | undefined,
    now: number,
    options: OfficeStoreOptions = {},
  ): boolean {
    const mode = options.mode ?? this.mode;
    const bubbleMs = options.bubbleMs ?? this.bubbleMs;
    const locale = options.locale ?? this.locale;
    const settingsChanged = mode !== this.mode || bubbleMs !== this.bubbleMs || locale !== this.locale;
    const profilesChanged = profiles !== this.profiles;

    const extendsApplied = !settingsChanged && !profilesChanged && events.length >= this.applied && (
      this.applied === 0 || (
        eventKey(events[0]) === this.firstKey && eventKey(events[this.applied - 1]) === this.lastKey
      )
    );

    if (extendsApplied && events.length === this.applied) return false;

    let start = this.applied;
    if (!extendsApplied) {
      this.mode = mode;
      this.bubbleMs = bubbleMs;
      this.locale = locale;
      this.profiles = profiles;
      this.state = createLiveSimulationState();
      this.applied = 0;
      start = 0;
      for (const profile of profiles ?? []) {
        applyExternalEvent(this.state, profileEvent(profile) as CanonicalEvent, this.applyOptions(now));
      }
    }

    this.applyBatch(events, start, now);
    this.applied = events.length;
    this.firstKey = events.length > 0 ? eventKey(events[0]) : null;
    this.lastKey = events.length > 0 ? eventKey(events[events.length - 1]) : null;
    advanceLivingOffice(this.state, now);
    return true;
  }

  /** Moves the office forward in time: walks finish and meetings start. Returns true when something changed. */
  tick(now: number): boolean {
    const before = signature(this.state);
    advanceLivingOffice(this.state, now);
    if (this.mode === 'showcase') {
      applyAmbientLife(this.state, now, this.locale.toLowerCase().startsWith('es') ? 'es' : 'en', {
        enabled: true,
        politicsEnabled: false,
        idleGraceMs: 12000,
        minIntervalMs: 18000,
      });
    }
    return signature(this.state) !== before;
  }

  /** Copies of the visible data, safe to hand to React. */
  snapshot(): OfficeSnapshot {
    return {
      agents: this.state.agents
        .filter((agent) => (agent.floor ?? 1) === 1)
        .map((agent) => ({
          ...agent,
          speechBubble: agent.speechBubble ? { ...agent.speechBubble } : null,
          ambientBubble: agent.ambientBubble ? { ...agent.ambientBubble } : null,
        })),
      activeMeetingId: this.state.activeMeetingId,
      meetings: this.state.meetings.map((meeting) => ({ ...meeting, messages: [...meeting.messages] })),
    };
  }

  private applyOptions(now: number): ApplyEventOptions {
    const professional = this.mode === 'professional';
    return {
      now,
      bubbleMs: this.bubbleMs,
      narrate: !professional,
      // The embedded office has no second-floor view, so meetings never move there.
      overflowFloor: false,
      // Usage figures come from the host (`usage` prop); the office never adds them up.
      trackUsage: false,
    };
  }

  /**
   * Applies events keeping their relative timing: an event that happened 10 s before the newest one in the
   * batch is applied as if it happened 10 s ago. Rebuilding a long run therefore shows only the bubbles and
   * walks that are still recent, instead of replaying every message at once.
   */
  private applyBatch(events: readonly OfficeEventInput[], start: number, now: number): void {
    let newest: number | null = null;
    for (let index = start; index < events.length; index++) {
      const timestamp = eventTimestamp(events[index]);
      if (timestamp !== null && (newest === null || timestamp > newest)) newest = timestamp;
    }
    for (let index = start; index < events.length; index++) {
      const timestamp = eventTimestamp(events[index]);
      const age = newest !== null && timestamp !== null ? Math.max(0, newest - timestamp) : 0;
      applyExternalEvent(
        this.state,
        events[index] as unknown as CanonicalEvent,
        this.applyOptions(now - age),
      );
    }
  }
}

/** Builds the office for a list of events in one call. Useful on the server, in tests and for exports. */
export function buildOfficeSnapshot(
  events: readonly OfficeEventInput[],
  options: OfficeStoreOptions & { agents?: readonly AgentProfile[]; now?: number } = {},
): OfficeSnapshot {
  const store = new OfficeStore(options);
  store.sync(events, options.agents, options.now ?? Date.now(), options);
  return store.snapshot();
}
