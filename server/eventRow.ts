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

/**
 * Issue #105: like `rowToEvent`, but never throws. The genesis/resume checkpoint digest must cover every row,
 * including one whose `payload` column is itself unparseable (the live rebuild path skips such a row and logs
 * it; a migration or a store constructor cannot skip a row the same way without silently shrinking the chain's
 * coverage of pre-chain history, and must not crash the server either). Falls back to a stable sentinel built
 * only from the row's `id` and raw stored text, so even a fully corrupt row still contributes a reproducible,
 * content-dependent value: editing its raw bytes still changes the digest.
 */
export function rowToEventForDigest(r: any): unknown {
  try {
    return rowToEvent(r);
  } catch {
    return { id: r.id, unparseable: true, eventJson: r.event_json ?? null, payload: r.payload ?? null };
  }
}
