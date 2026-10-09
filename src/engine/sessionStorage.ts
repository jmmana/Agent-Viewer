import type { SimulationState } from './simulationEngine';

export const SESSION_STORAGE_KEY = 'agent-viewer-session-v1';
export const SESSION_SCHEMA_VERSION = 2;
/** Schema versions this build still knows how to load (and migrate forward from). */
const READABLE_SCHEMA_VERSIONS = new Set([1, SESSION_SCHEMA_VERSION]);

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface StoredSession {
  schemaVersion: number;
  savedAt: number;
  state: SimulationState;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isCompatibleSimulationState(value: unknown): value is SimulationState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Record<string, unknown>;
  const totals = state.totalTokens as Record<string, unknown> | undefined;

  return (
    Array.isArray(state.agents) &&
    Array.isArray(state.tasks) &&
    Array.isArray(state.meetings) &&
    Array.isArray(state.events) &&
    Array.isArray(state.roomReservations) &&
    Array.isArray(state.socialActivities) &&
    Array.isArray(state.coffeeSeatAssignments) &&
    (state.activeMeetingId === null || typeof state.activeMeetingId === 'string') &&
    !!totals &&
    isFiniteNumber(totals.input) &&
    isFiniteNumber(totals.output) &&
    isFiniteNumber(totals.cached) &&
    isFiniteNumber(totals.reasoning) &&
    isFiniteNumber(state.totalCost)
  );
}

export function serializeSession(state: SimulationState, savedAt = Date.now()): string {
  const envelope: StoredSession = {
    schemaVersion: SESSION_SCHEMA_VERSION,
    savedAt,
    state,
  };
  return JSON.stringify(envelope);
}

function isBurstEventId(id: unknown): boolean {
  return typeof id === 'string' && id.startsWith('evt-burst-');
}

function clampNonNegative(value: number): number {
  return value < 0 ? 0 : value;
}

/**
 * Migrates a v1 session to v2: 0.2.x Model Ops simulated bursts were written as real `llm.usage` events
 * (`evt-burst-*`) and added straight into agent and office counters. This removes those events and reverses
 * their effect, clamped at 0. A burst whose event was already evicted from the stored event list (the event
 * log is capped) cannot be reversed, so its counters stay; this is a known, documented limitation.
 */
function migrateV1ToV2(state: SimulationState): SimulationState {
  const burstEvents = state.events.filter((event) => isBurstEventId((event as { id?: unknown }).id));
  if (burstEvents.length === 0) return state;

  const agents = state.agents.map((agent) => ({ ...agent }));
  let input = state.totalTokens.input;
  let output = state.totalTokens.output;
  let cached = state.totalTokens.cached;
  let cost = state.totalCost;

  for (const event of burstEvents) {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const burstInput = typeof payload.inputTokens === 'number' ? payload.inputTokens : 0;
    const burstOutput = typeof payload.outputTokens === 'number' ? payload.outputTokens : 0;
    const burstCached = typeof payload.cachedTokens === 'number' ? payload.cachedTokens : 0;
    const burstCost = typeof payload.cost === 'number' ? payload.cost : 0;

    const agent = agents.find((a) => a.id === event.source);
    if (agent) {
      agent.tokensInput = clampNonNegative(agent.tokensInput - burstInput);
      agent.tokensOutput = clampNonNegative(agent.tokensOutput - burstOutput);
      agent.cachedTokens = clampNonNegative(agent.cachedTokens - burstCached);
      agent.cost = clampNonNegative(agent.cost - burstCost);
    }

    input = clampNonNegative(input - burstInput);
    output = clampNonNegative(output - burstOutput);
    cached = clampNonNegative(cached - burstCached);
    cost = clampNonNegative(cost - burstCost);
  }

  return {
    ...state,
    agents,
    events: state.events.filter((event) => !isBurstEventId((event as { id?: unknown }).id)),
    totalTokens: { ...state.totalTokens, input, output, cached },
    totalCost: cost,
  };
}

export function deserializeSession(raw: string | null): SimulationState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (typeof parsed.schemaVersion !== 'number' || !READABLE_SCHEMA_VERSIONS.has(parsed.schemaVersion)) return null;
    if (!isFiniteNumber(parsed.savedAt)) return null;
    if (!isCompatibleSimulationState(parsed.state)) return null;
    return parsed.schemaVersion === 1 ? migrateV1ToV2(parsed.state) : parsed.state;
  } catch {
    return null;
  }
}

export function loadSession(storage: StorageLike): SimulationState | null {
  return deserializeSession(storage.getItem(SESSION_STORAGE_KEY));
}

export function saveSession(storage: StorageLike, state: SimulationState): void {
  storage.setItem(SESSION_STORAGE_KEY, serializeSession(state));
}

export function clearSession(storage: StorageLike): void {
  storage.removeItem(SESSION_STORAGE_KEY);
}

export function createThrottledSessionWriter(
  storage: StorageLike,
  delayMs = 1000,
): {
  schedule: (state: SimulationState) => void;
  flush: () => void;
  cancel: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: SimulationState | null = null;

  const flush = () => {
    if (!pending) return;
    saveSession(storage, pending);
    pending = null;
    if (timer) clearTimeout(timer);
    timer = null;
  };

  return {
    schedule(state) {
      pending = state;
      if (timer) return;
      timer = setTimeout(flush, delayMs);
    },
    flush,
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}
