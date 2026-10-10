/**
 * Attribution rules for the `meeting` and `tool` rollup dimensions (issue #80), shared, pure, and used
 * identically by the memory and SQLite rollup paths so the two stores cannot drift (the issue's own
 * requirement: "one shared pure function so the two stores cannot drift").
 *
 * Hard rule, repeated here because it is the whole point of this module: no time-overlap heuristic, no
 * "the agent was in a meeting at that moment" inference, no nearest `tool.started`, no inference from `taskId`
 * or agent. A call is `attributed` only when the reporter sent the explicit link (`meetingId` or `toolCallId`
 * on the `llm.usage`/`llm.failed` payload); otherwise it is `unattributed`, full stop. Guessing by time overlap
 * is the classic way to produce a plausible but false audit figure (two agents working in parallel, a tool call
 * overlapping three unrelated model calls), which is exactly what this feature exists to avoid.
 */

/** `tool` dimension attribution states (issue #80, section 1's table). */
export type ToolAttributionState = 'attributed' | 'unattributed' | 'unresolved' | 'ambiguous';

/** `meeting` dimension attribution states. A meeting link is never ambiguous or unresolved: either the reporter
 * sent a `meetingId` (attributed, whether or not a label for it was ever seen) or it did not (unattributed). */
export type MeetingAttributionState = 'attributed' | 'unattributed';

/** Either attribution state, used where code treats both dimensions generically (ordering, response shaping). */
export type AttributionState = ToolAttributionState | MeetingAttributionState;

export type AttributionDimension = 'meeting' | 'tool';

/**
 * Resolution scope for a tool call id (issue #80): `(sessionId, agentId, toolCallId)` of the usage row, matched
 * against `tool.started` events stored with the same three values. A missing session or agent is its own scope
 * (`''`), so an SDK reporter that numbers its calls `1, 2, 3` in different sessions never collides with another
 * reporter's own `1, 2, 3`. Exported so the SQLite write path, the backfill and the memory-mode reducer all
 * build the identical key.
 */
export function toolCallScopeKey(sessionId: string | null | undefined, agentId: string | null | undefined, toolCallId: string): string {
  return `${sessionId ?? ''}\u0000${agentId ?? ''}\u0000${toolCallId}`;
}

export interface ToolAttributionResult {
  attribution: ToolAttributionState;
  /** The resolved tool name, only when `attribution` is `'attributed'`. Never set for any other state. */
  tool: string | null;
}

export interface MeetingAttributionResult {
  attribution: MeetingAttributionState;
  meetingId: string | null;
  /** The meeting's latest recorded non-empty title, or `null` when none was ever seen. Only meaningful when
   * `attribution` is `'attributed'` (an unattributed row carries no meeting id to look a title up for). */
  title: string | null;
}

/**
 * Resolves the `tool` dimension for one usage row. `toolNamesByScope` maps `toolCallScopeKey(...)` to the set of
 * distinct tool names seen on a `tool.started` event in that exact scope (built by `server/serverState.ts` in
 * memory mode, by the `tool_calls` SQLite table in SQLite mode). Two `tool.started` events with the same scope
 * and the same name are one tool call (the set has one element); the same scope with different names is
 * `ambiguous` (the set has more than one element), and neither case ever picks a name for an ambiguous call.
 */
export function resolveToolAttribution(
  row: { sessionId: string | null | undefined; agentId: string | null | undefined; toolCallId: string | null | undefined },
  toolNamesByScope: ReadonlyMap<string, ReadonlySet<string>>
): ToolAttributionResult {
  if (!row.toolCallId) return { attribution: 'unattributed', tool: null };
  const names = toolNamesByScope.get(toolCallScopeKey(row.sessionId, row.agentId, row.toolCallId));
  if (!names || names.size === 0) return { attribution: 'unresolved', tool: null };
  if (names.size > 1) return { attribution: 'ambiguous', tool: null };
  const [onlyName] = names;
  return { attribution: 'attributed', tool: onlyName ?? null };
}

/**
 * Resolves the `meeting` dimension for one usage row. `titlesByMeetingId` maps a meeting id to the latest
 * accepted non-empty title for it (last write wins by server acceptance order, never by event timestamp: see
 * the module doc comment on `server/serverState.ts`). A `meetingId` with no meeting event is still `attributed`
 * (the link exists); its title is simply `null`.
 */
export function resolveMeetingAttribution(
  meetingId: string | null | undefined,
  titlesByMeetingId: ReadonlyMap<string, string>
): MeetingAttributionResult {
  if (!meetingId) return { attribution: 'unattributed', meetingId: null, title: null };
  return { attribution: 'attributed', meetingId, title: titlesByMeetingId.get(meetingId) ?? null };
}

/** Per-dimension attribution rank (issue #80, section 1): `attributed` first, `unattributed` last, so every
 * group with a usable link sorts before every group without one, in a fixed order. */
export const ATTRIBUTION_RANK: Record<AttributionState, number> = {
  attributed: 0,
  unresolved: 1,
  ambiguous: 2,
  unattributed: 3,
};

/** Free-text values in a rollup response (meeting `title`, resolved `tool` name) are truncated to this many
 * UTF-16 code units before redaction (issue #80, issue #68's redaction baseline runs after). Resolution and
 * ambiguity detection (above) always use the full stored value; only the *response* value is truncated, and
 * groups whose keys become equal only after truncation are merged by the caller (`server/usage/rollup.ts`). */
export const FREE_TEXT_MAX_LENGTH = 200;

export function truncateFreeText(value: string | null): string | null {
  if (value === null) return null;
  return value.length > FREE_TEXT_MAX_LENGTH ? value.slice(0, FREE_TEXT_MAX_LENGTH) : value;
}

/** Cap on `sessionIds` in a `meeting`-grouped response (issue #80): `sessionCount` is always the true distinct
 * count, even when the list itself is capped, so a collision or a cap is visible rather than hidden. */
export const SESSION_IDS_CAP = 20;
