import type { CanonicalEvent } from '../src/integrations/canonicalContract';

/**
 * Rebuilds a `CanonicalEvent` from one raw SQLite `events` row. Shared by `SQLiteEventStore` (the live path and
 * the startup rebuild) and the usage ledger backfill (issue #65), so both read exactly the same event shape from
 * storage. Prefers `event_json` (the full envelope, as accepted); a row written before that column existed falls
 * back to the indexed columns, which is enough to rebuild a valid `CanonicalEvent` (payload comes from the
 * always-present `payload` column).
 */
export function rowToEvent(r: any): CanonicalEvent {
  if (typeof r.event_json === 'string' && r.event_json.length > 0) {
    try {
      return JSON.parse(r.event_json) as CanonicalEvent;
    } catch {
      // Fall back to the column mapping below.
    }
  }

  return {
    schemaVersion: '1.0' as const,
    id: r.id,
    type: r.type,
    timestamp: Number(r.timestamp),
    runtimeId: r.runtime_id ?? undefined,
    sessionId: r.session_id ?? undefined,
    source: r.agent_id ? `agent:${r.agent_id}` : (r.runtime_id ? `runtime:${r.runtime_id}` : 'external'),
    agentId: r.agent_id ?? undefined,
    taskId: r.task_id ?? undefined,
    severity: r.severity,
    summary: r.summary,
    payload: JSON.parse(r.payload || '{}'),
  };
}
