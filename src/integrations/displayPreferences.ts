/**
 * Display-only portal preferences for the ledger-backed usage surfaces (issue #78): whether to mask secrets in
 * call detail (`requestId` shown shortened, free-text fields hidden) and whether to draw the per-agent spend
 * badges on the canvas. Both are persisted in `localStorage`, same pattern as `usageWindow.ts`: a `Pick<Storage,
 * 'getItem'>` / `Pick<Storage, 'setItem'>` parameter so tests can pass a fake store without a real DOM.
 *
 * Neither preference changes what the server stores or redacts: they only control what this browser tab draws.
 * `mask-secrets` off never un-redacts a `[REDACTED:...]` marker the server already applied (see
 * `src/integrations/redaction.ts`); it only stops the portal from additionally shortening fields client-side.
 */
export const MASK_SECRETS_STORAGE_KEY = 'agent-viewer:mask-secrets';
export const SHOW_USAGE_BADGES_STORAGE_KEY = 'agent-viewer:show-usage-badges';

function loadBooleanPreference(storage: Pick<Storage, 'getItem'> | undefined, key: string, fallback: boolean): boolean {
  const stored = storage?.getItem(key);
  if (stored === 'true') return true;
  if (stored === 'false') return false;
  return fallback;
}

function saveBooleanPreference(storage: Pick<Storage, 'setItem'> | undefined, key: string, value: boolean): void {
  storage?.setItem(key, value ? 'true' : 'false');
}

/** Default `true`: calls are shown with `requestId` shortened until the operator explicitly opts out. */
export function loadMaskSecrets(storage: Pick<Storage, 'getItem'> | undefined): boolean {
  return loadBooleanPreference(storage, MASK_SECRETS_STORAGE_KEY, true);
}

export function saveMaskSecrets(storage: Pick<Storage, 'setItem'> | undefined, value: boolean): void {
  saveBooleanPreference(storage, MASK_SECRETS_STORAGE_KEY, value);
}

/** Default `true`: badges are drawn whenever the ledger has figures, until the operator hides them (for example
 * while sharing the screen). The top-bar total is never gated by this preference. */
export function loadShowUsageBadges(storage: Pick<Storage, 'getItem'> | undefined): boolean {
  return loadBooleanPreference(storage, SHOW_USAGE_BADGES_STORAGE_KEY, true);
}

export function saveShowUsageBadges(storage: Pick<Storage, 'setItem'> | undefined, value: boolean): void {
  saveBooleanPreference(storage, SHOW_USAGE_BADGES_STORAGE_KEY, value);
}
