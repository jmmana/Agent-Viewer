import type { SimulationState } from './simulationEngine';

export const SESSION_STORAGE_KEY = 'agent-viewer-session-v1';
export const SESSION_SCHEMA_VERSION = 1;

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

export function deserializeSession(raw: string | null): SimulationState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (parsed.schemaVersion !== SESSION_SCHEMA_VERSION) return null;
    if (!isFiniteNumber(parsed.savedAt)) return null;
    if (!isCompatibleSimulationState(parsed.state)) return null;
    return parsed.state;
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
