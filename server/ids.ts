import crypto from 'node:crypto';

/** Kinds of events the server builds on its own. The agent or runtime id lives on the envelope, never in the id. */
export type ServerEventKind = 'reg' | 'status' | 'upd' | 'rt' | 'wh_status' | 'wh_msg' | 'wh_tool' | 'wh_usage';

/**
 * Collision-free id for an event the server generates: 122 random bits from a CSPRNG, never the clock.
 * Every result matches `^evt_[a-z_]+_[0-9a-f-]{36}$`.
 */
export const serverEventId = (kind: ServerEventKind): string => `evt_${kind}_${crypto.randomUUID()}`;
