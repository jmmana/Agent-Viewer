/**
 * Usage window selector for the portal's ledger-backed spend badges and top-bar total (issue #78). Persisted
 * choice, computed range: `from` is always recomputed from the current clock at request time (never cached),
 * `to` is omitted so calls that land after the request was built are still included next refresh.
 */
export type UsageWindowOption = 'lastHour' | 'today' | '7d' | 'all';

export const USAGE_WINDOW_OPTIONS: readonly UsageWindowOption[] = ['lastHour', 'today', '7d', 'all'];

export const USAGE_WINDOW_STORAGE_KEY = 'agent-viewer:usage-window';

export interface UsageWindowRange {
  from?: number;
  to?: number;
}

/** "All" never polls on a clock tick: there is no moving `from` to keep in sync. */
export function isRollingWindow(option: UsageWindowOption): boolean {
  return option !== 'all';
}

export function usageWindowRange(option: UsageWindowOption, now: number): UsageWindowRange {
  if (option === 'all') return {};
  if (option === 'lastHour') return { from: now - 60 * 60 * 1000 };
  if (option === '7d') return { from: now - 7 * 24 * 60 * 60 * 1000 };
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return { from: midnight.getTime() };
}

function isUsageWindowOption(value: unknown): value is UsageWindowOption {
  return typeof value === 'string' && (USAGE_WINDOW_OPTIONS as readonly string[]).includes(value);
}

export function loadUsageWindow(storage: Pick<Storage, 'getItem'> | undefined): UsageWindowOption {
  const stored = storage?.getItem(USAGE_WINDOW_STORAGE_KEY);
  return isUsageWindowOption(stored) ? stored : 'all';
}

export function saveUsageWindow(storage: Pick<Storage, 'setItem'> | undefined, option: UsageWindowOption): void {
  storage?.setItem(USAGE_WINDOW_STORAGE_KEY, option);
}
