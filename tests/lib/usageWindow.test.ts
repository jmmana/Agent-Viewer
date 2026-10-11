/**
 * Tests for the usage window selector (issue #78): range computation and localStorage persistence.
 */
import { describe, expect, it } from 'vitest';
import {
  isRollingWindow,
  loadUsageWindow,
  saveUsageWindow,
  usageWindowRange,
  USAGE_WINDOW_STORAGE_KEY,
} from '../../src/integrations/usageWindow';

function fakeStorage(initial: Record<string, string> = {}): Storage {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
  } as Storage;
}

describe('usageWindowRange', () => {
  const now = new Date('2026-10-08T15:00:00Z').getTime();

  it('all sends neither from nor to', () => {
    expect(usageWindowRange('all', now)).toEqual({});
  });

  it('lastHour is now minus one hour', () => {
    expect(usageWindowRange('lastHour', now)).toEqual({ from: now - 60 * 60 * 1000 });
  });

  it('7d is now minus seven days', () => {
    expect(usageWindowRange('7d', now)).toEqual({ from: now - 7 * 24 * 60 * 60 * 1000 });
  });

  it('today is local midnight, not UTC midnight or a fixed offset', () => {
    const { from } = usageWindowRange('today', now);
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    expect(from).toBe(midnight.getTime());
  });

  it('never sets to: new calls after the request is built are still included on the next refresh', () => {
    expect(usageWindowRange('lastHour', now).to).toBeUndefined();
  });
});

describe('isRollingWindow', () => {
  it('is true for every option except all', () => {
    expect(isRollingWindow('lastHour')).toBe(true);
    expect(isRollingWindow('today')).toBe(true);
    expect(isRollingWindow('7d')).toBe(true);
    expect(isRollingWindow('all')).toBe(false);
  });
});

describe('persistence', () => {
  it('defaults to all with no storage or an unrecognized value', () => {
    expect(loadUsageWindow(undefined)).toBe('all');
    expect(loadUsageWindow(fakeStorage({ [USAGE_WINDOW_STORAGE_KEY]: 'nonsense' }))).toBe('all');
  });

  it('round-trips a saved option', () => {
    const storage = fakeStorage();
    saveUsageWindow(storage, '7d');
    expect(loadUsageWindow(storage)).toBe('7d');
  });
});
