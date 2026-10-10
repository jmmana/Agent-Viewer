/**
 * Tests for the display-only `mask-secrets` / `show-usage-badges` preferences (issue #78): persisted under their
 * own storage keys, default `true`, and tolerant of a fake store (no real DOM) or no store at all.
 */
import { describe, expect, it } from 'vitest';
import {
  loadMaskSecrets,
  saveMaskSecrets,
  loadShowUsageBadges,
  saveShowUsageBadges,
  MASK_SECRETS_STORAGE_KEY,
  SHOW_USAGE_BADGES_STORAGE_KEY,
} from '../../src/integrations/displayPreferences';

function fakeStorage(initial: Record<string, string> = {}) {
  const store = { ...initial };
  return {
    getItem: (key: string) => (key in store ? store[key] : null),
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    raw: store,
  };
}

describe('displayPreferences', () => {
  it('defaults mask-secrets to true when nothing is stored', () => {
    expect(loadMaskSecrets(fakeStorage())).toBe(true);
    expect(loadMaskSecrets(undefined)).toBe(true);
  });

  it('defaults show-usage-badges to true when nothing is stored', () => {
    expect(loadShowUsageBadges(fakeStorage())).toBe(true);
    expect(loadShowUsageBadges(undefined)).toBe(true);
  });

  it('round-trips mask-secrets through its own storage key', () => {
    const storage = fakeStorage();
    saveMaskSecrets(storage, false);
    expect(storage.raw[MASK_SECRETS_STORAGE_KEY]).toBe('false');
    expect(loadMaskSecrets(storage)).toBe(false);
    saveMaskSecrets(storage, true);
    expect(loadMaskSecrets(storage)).toBe(true);
  });

  it('round-trips show-usage-badges through its own storage key, independent of mask-secrets', () => {
    const storage = fakeStorage();
    saveShowUsageBadges(storage, false);
    expect(storage.raw[SHOW_USAGE_BADGES_STORAGE_KEY]).toBe('false');
    expect(loadShowUsageBadges(storage)).toBe(false);
    expect(loadMaskSecrets(storage)).toBe(true);
  });

  it('an unrecognized stored value falls back to the default instead of throwing', () => {
    const storage = fakeStorage({ [MASK_SECRETS_STORAGE_KEY]: 'garbage' });
    expect(loadMaskSecrets(storage)).toBe(true);
  });

  it('saving is a no-op when no storage is given', () => {
    expect(() => saveMaskSecrets(undefined, false)).not.toThrow();
    expect(() => saveShowUsageBadges(undefined, false)).not.toThrow();
  });
});
