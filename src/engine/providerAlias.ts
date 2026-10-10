/**
 * Canonical provider matching for Model Ops (issue #79). The ledger stores raw provider ids (`'anthropic'`,
 * `'openai'`, `'google'`, `'ollama'`), while the office's own display names (`PROVIDER_METADATA` in
 * `engine/modelOps.ts`, the rack filter values in `OfficeCanvas.tsx`) use `'Google Gemini'` / `'Local (Ollama)'`.
 * Styling and filter matching go through this canonical key so `'anthropic'`, `'Anthropic'`, `'OPENAI'` and a
 * rack's `'Google Gemini'` all resolve to the same bucket; rows are never renamed or merged, only matched.
 */

/** One canonical key per provider family this demo knows how to style. Anything else keeps its own lowercase
 * value as the key, so an unknown ledger provider still gets a stable (if generic) style. */
export type CanonicalProviderKey = 'anthropic' | 'openai' | 'google' | 'ollama' | (string & {});

const ALIAS_TO_CANONICAL: Record<string, CanonicalProviderKey> = {
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'google',
  gemini: 'google',
  'google gemini': 'google',
  ollama: 'ollama',
  'local (ollama)': 'ollama',
  local: 'ollama',
};

/** Case-insensitive, alias-aware canonical key for a raw provider string (ledger id or office display name). */
export function canonicalProviderKey(provider: string): CanonicalProviderKey {
  const lower = provider.trim().toLowerCase();
  return ALIAS_TO_CANONICAL[lower] ?? lower;
}

/** True when two provider strings (any mix of ledger id and office display name) name the same provider. */
export function providersMatch(a: string, b: string): boolean {
  return canonicalProviderKey(a) === canonicalProviderKey(b);
}

export interface LedgerProviderStyle {
  label: string;
  color: string;
  badgeBg: string;
  badgeBorder: string;
  accent: string;
}

/** Styling keyed by canonical provider, used by the ledger-backed tabs (Matrix, Agents, Feed) so a raw ledger id
 * gets the same color family the demo's `PROVIDER_METADATA` already uses for its display names. The `label` here
 * is only the generic fallback name; callers show the raw ledger provider string, never this label, when one is
 * available (the model card shows the model id exactly as reported, the provider string exactly as reported). */
const CANONICAL_PROVIDER_STYLES: Record<string, LedgerProviderStyle> = {
  anthropic: {
    label: 'Anthropic',
    color: '#d97706',
    badgeBg: 'bg-amber-500/10',
    badgeBorder: 'border-amber-500/30',
    accent: 'text-amber-400',
  },
  openai: {
    label: 'OpenAI',
    color: '#10a37f',
    badgeBg: 'bg-emerald-500/10',
    badgeBorder: 'border-emerald-500/30',
    accent: 'text-emerald-400',
  },
  google: {
    label: 'Google',
    color: '#2563eb',
    badgeBg: 'bg-sky-500/10',
    badgeBorder: 'border-sky-500/30',
    accent: 'text-sky-400',
  },
  ollama: {
    label: 'Ollama',
    color: '#a855f7',
    badgeBg: 'bg-purple-500/10',
    badgeBorder: 'border-purple-500/30',
    accent: 'text-purple-400',
  },
};

const GENERIC_PROVIDER_STYLE: LedgerProviderStyle = {
  label: '',
  color: '#38bdf8',
  badgeBg: 'bg-cyan-500/10',
  badgeBorder: 'border-cyan-500/30',
  accent: 'text-cyan-400',
};

/** Style for a raw ledger provider string: alias-aware, case-insensitive, with a generic fallback (never a
 * silent re-use of another provider's style). `label` on the fallback is the input string itself. */
export function ledgerProviderStyle(provider: string): LedgerProviderStyle {
  const key = canonicalProviderKey(provider);
  const known = CANONICAL_PROVIDER_STYLES[key];
  if (known) return known;
  return { ...GENERIC_PROVIDER_STYLE, label: provider };
}
