import type { OfficeTranslate } from '../content/officeMessages';

/**
 * A budget verdict decided by the host (issue #87). The office never computes it: it never holds a limit,
 * never receives a spend figure and never compares one against the other. `unknown` is explicit and
 * distinct from both `ok` and "not provided", so a host that cannot evaluate a budget (no limit configured,
 * mixed currencies, a missing price) never produces a reassuring look.
 */
export type BudgetState = 'ok' | 'warning' | 'exceeded' | 'unknown';

/** The four states, in the order the office checks them. */
export const BUDGET_STATES: readonly BudgetState[] = ['ok', 'warning', 'exceeded', 'unknown'];

/** Labels longer than this are cut (by code point, never splitting a surrogate pair). */
export const MAX_BUDGET_LABEL_LENGTH = 80;

/**
 * One agent's budget verdict, decided by the host. There is deliberately no `limit`, `spent`, `percent`,
 * `currency` or `threshold` field: the office cannot compare spend with a limit because it is never given
 * either number.
 */
export interface AgentBudgetState {
  state: BudgetState;
  /**
   * Optional short text from the host, already translated, for example "Daily budget at 82%". Shown as is,
   * in the agent list only. The office never parses it, never derives figures from it and never translates
   * it.
   */
  label?: string;
}

function isBudgetState(value: unknown): value is BudgetState {
  return typeof value === 'string' && (BUDGET_STATES as readonly string[]).includes(value);
}

/** Cuts `value` to `MAX_BUDGET_LABEL_LENGTH` Unicode code points, never splitting a surrogate pair. */
function clampToMaxLength(value: string): string {
  const codePoints = Array.from(value);
  return codePoints.length > MAX_BUDGET_LABEL_LENGTH ? codePoints.slice(0, MAX_BUDGET_LABEL_LENGTH).join('') : value;
}

/**
 * A non-string `label` is dropped. A string one is trimmed, has every Unicode control character removed
 * (`\p{Cc}`, including newlines and tabs), is cut to `MAX_BUDGET_LABEL_LENGTH` code points, and an empty
 * result is dropped too (so a card never shows an empty label).
 */
function normalizeLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const withoutControlChars = value.replace(/\p{Cc}/gu, '');
  const cleaned = clampToMaxLength(withoutControlChars.trim());
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Normalizes one host-provided budget entry. Only `state` and `label` ever reach the result: an extra
 * runtime field (a JS host sending `limit` or `spent`) is dropped, not read and never stored.
 *
 * `{ state: 'unknown' }` (with no label) is returned, never `{ state: 'ok' }`, whenever the input is not a
 * plain object (`null`, a number, a string, an array), or when `state` is missing or outside the four known
 * literals: an invalid or absent verdict is never read as a healthy one. Map keys are read by the caller
 * with `Object.entries`, so a key such as `__proto__` or `constructor` is a plain agent id here and never
 * touches a prototype.
 */
export function normalizeBudgetState(input: unknown): AgentBudgetState {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { state: 'unknown' };
  const fields = input as Record<string, unknown>;
  if (!isBudgetState(fields.state)) return { state: 'unknown' };
  const label = normalizeLabel(fields.label);
  return label !== undefined ? { state: fields.state, label } : { state: fields.state };
}

/**
 * Formats a normalized entry for the accessible agent list: the state text, with the host's own label
 * appended verbatim (it arrives already translated; the office never translates it) when present. Expects
 * an already normalized entry, as returned by `normalizeBudgetState`.
 */
export function formatBudgetState(entry: AgentBudgetState, translate: OfficeTranslate): string {
  const stateText = translate(`budget.state.${entry.state}`);
  if (entry.label) return translate('budget.withLabel', { state: stateText, label: entry.label });
  return stateText;
}
