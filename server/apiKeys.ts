/**
 * Named API keys (issue #107): replaces the single shared bootstrap token as the only way to identify who
 * submitted an event. A key's secret is stored only as a SHA-256 hash; the full token is returned exactly once,
 * at creation. SQLite only (keys must survive a restart to be auditable); memory mode has no registry at all,
 * and the routes answer `501 keys_require_sqlite`.
 *
 * `submitter_id` on `events` (issue #105) is reused as the identity column this module fills with richer
 * values (`key_...`, `bootstrap`, `webhook`, `anonymous`) instead of #105's own generic ones, exactly as #105's
 * own dependency note anticipates: "if #105 ships first, it reserves the field (null) in its hash input and
 * this item fills it in a versioned chain format step." No second column is introduced.
 */
import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/** `avk_<12 hex id>.<43 char base64url secret>`. Distinct from the CLI session token prefix `av_`. */
export const API_KEY_TOKEN_PATTERN = /^avk_([0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;

/** A name is 1 to 64 characters, trimmed, with no control or format Unicode characters. */
const NAME_FORBIDDEN_CATEGORY = /\p{Cc}|\p{Cf}/u;

export type ApiKeyStatus = 'active' | 'expired' | 'revoked';

export interface ApiKeyRecord {
  id: string;
  name: string;
  prefix: string;
  status: ApiKeyStatus;
  createdAt: number;
  createdBy: string;
  expiresAt: number | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
  revokedBy: string | null;
  eventCount: number;
  firstEventAt: number | null;
  lastEventAt: number | null;
}

export interface ApiKeyCreated {
  id: string;
  name: string;
  prefix: string;
  token: string;
  createdAt: number;
  createdBy: string;
  expiresAt: number | null;
}

export class ApiKeyValidationError extends Error {
  constructor(
    readonly path: string,
    message: string
  ) {
    super(message);
    this.name = 'ApiKeyValidationError';
  }
}

export class ApiKeyNameTakenError extends Error {
  constructor() {
    super('A key with this name already exists');
    this.name = 'ApiKeyNameTakenError';
  }
}

/** Thrown by every `ApiKeyStore` method when the store is `createUnsupportedApiKeyStore()` (memory mode). The
 * routes map this to `501 keys_require_sqlite`. */
export class KeysUnsupportedError extends Error {
  constructor() {
    super('Named API keys require AGENT_VIEWER_STORAGE=sqlite: set it and restart to use this endpoint.');
    this.name = 'KeysUnsupportedError';
  }
}

export interface CreateApiKeyInput {
  name: string;
  /** Epoch ms. Mutually exclusive with nothing else here: the route resolves `expiresIn` to this before calling. */
  expiresAt?: number | null;
  createdBy: string;
}

/** Fully synchronous, mirroring `BudgetRegistry` (`server/budgets.ts`): `node:sqlite` is itself synchronous, so
 * wrapping these in a `Promise` would only add noise, and the auth middleware (on the hot path of every
 * `/api/v1` request) needs a key lookup it can call without `await`. */
export interface ApiKeyStore {
  create(input: CreateApiKeyInput): ApiKeyCreated;
  /** `null` for raw plumbing used only by the fast auth-time lookup; never exposed over the API. */
  findForAuth(id: string): { id: string; secretHash: string; status: ApiKeyStatus; name: string } | null;
  get(id: string): ApiKeyRecord | null;
  list(): ApiKeyRecord[];
  /** Idempotent: a second call on an already-revoked key returns the same record (original `revokedAt`), and
   * writes no second audit trail entry (the caller decides whether to append one, based on `alreadyRevoked`). */
  revoke(id: string, revokedBy: string): { record: ApiKeyRecord; alreadyRevoked: boolean } | null;
  /** Best effort, at most once per 60s per key; must never throw. */
  touchLastUsed(id: string): void;
}

function normalizeName(name: string): string {
  return name.trim().normalize('NFC');
}

function validateName(name: unknown): string {
  if (typeof name !== 'string') throw new ApiKeyValidationError('name', 'must be a string');
  const normalized = normalizeName(name);
  if (normalized.length < 1 || normalized.length > 64) {
    throw new ApiKeyValidationError('name', 'must be 1 to 64 characters after trimming');
  }
  if (NAME_FORBIDDEN_CATEGORY.test(normalized)) {
    throw new ApiKeyValidationError('name', 'must not contain control or format characters');
  }
  return normalized;
}

function statusOf(row: { expiresAt: number | null; revokedAt: number | null }, now: number): ApiKeyStatus {
  if (row.revokedAt !== null) return 'revoked';
  if (row.expiresAt !== null && row.expiresAt <= now) return 'expired';
  return 'active';
}

/** Generates a fresh `key_<id>` / `avk_<id>.<secret>` pair. A collision (astronomically unlikely at 48 bits of
 * id entropy) is handled by the caller retrying with a new id. */
function generateKeyMaterial(): { id: string; prefix: string; token: string; secretHash: string } {
  const idHex = crypto.randomBytes(6).toString('hex'); // 12 hex chars
  const secret = crypto.randomBytes(32).toString('base64url'); // 43 chars, no padding
  const id = `key_${idHex}`;
  const prefix = `avk_${idHex}`;
  const token = `${prefix}.${secret}`;
  const secretHash = crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
  return { id, prefix, token, secretHash };
}

/** Fixed dummy hash compared against an unknown id, so an unknown id and a wrong secret on a known id run the
 * same hash-then-compare code path, the same number of times. Both the dummy and a real `secret_hash` are
 * always 64 lowercase hex characters (a fixed SHA-256 digest), so `timingSafeEqual` never throws on a length
 * mismatch here. */
const DUMMY_SECRET_HASH = crypto.createHash('sha256').update('agent-viewer-dummy-comparison', 'utf8').digest('hex');

/** `true` when `secret` hashes to `storedHash`. Pass `null` for an unknown id: the comparison still runs,
 * against `DUMMY_SECRET_HASH`, so a probe cannot learn whether an id exists from timing alone. */
export function verifyKeySecret(secret: string, storedHash: string | null): boolean {
  const candidateHash = crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
  return crypto.timingSafeEqual(Buffer.from(candidateHash, 'utf8'), Buffer.from(storedHash ?? DUMMY_SECRET_HASH, 'utf8'));
}

export function createUnsupportedApiKeyStore(): ApiKeyStore {
  const fail = (): never => {
    throw new KeysUnsupportedError();
  };
  return {
    create: fail,
    findForAuth: fail,
    get: fail,
    list: fail,
    revoke: fail,
    touchLastUsed: () => {
      // Best effort and silent everywhere, including here: nothing to touch in memory mode.
    },
  };
}

export interface SqliteApiKeyStoreOptions {
  now?: () => number;
}

export function createSqliteApiKeyStore(db: DatabaseSync, options: SqliteApiKeyStoreOptions = {}): ApiKeyStore {
  const now = options.now ?? Date.now;
  /** Throttles `last_used_at` writes to at most once per 60s per key, in memory (lost on restart, which is
   * fine: the column itself is best-effort informational, never part of the chain or an access decision). */
  const lastTouchAt = new Map<string, number>();

  function rowToRecord(row: any, current: number): ApiKeyRecord {
    const expiresAt = row.expires_at === null ? null : Number(row.expires_at);
    const revokedAt = row.revoked_at === null ? null : Number(row.revoked_at);
    const eventStats = db
      .prepare('SELECT COUNT(*) AS c, MIN(timestamp) AS first, MAX(timestamp) AS last FROM events WHERE submitter_id = ?')
      .get(row.id) as { c: number; first: number | null; last: number | null };
    return {
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      status: statusOf({ expiresAt, revokedAt }, current),
      createdAt: Number(row.created_at),
      createdBy: row.created_by,
      expiresAt,
      lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at),
      revokedAt,
      revokedBy: row.revoked_by ?? null,
      eventCount: Number(eventStats.c),
      firstEventAt: eventStats.first === null ? null : Number(eventStats.first),
      lastEventAt: eventStats.last === null ? null : Number(eventStats.last),
    };
  }

  return {
    create(input) {
      const name = validateName(input.name);
      if (input.expiresAt !== undefined && input.expiresAt !== null) {
        if (!Number.isFinite(input.expiresAt) || input.expiresAt <= now()) {
          throw new ApiKeyValidationError('expiresAt', 'must be an integer timestamp in the future');
        }
      }
      const nameNorm = name.toLowerCase();
      const existing = db.prepare('SELECT id FROM api_keys WHERE name_norm = ?').get(nameNorm);
      if (existing) throw new ApiKeyNameTakenError();

      for (let attempt = 0; attempt < 5; attempt++) {
        const material = generateKeyMaterial();
        const collision = db.prepare('SELECT id FROM api_keys WHERE id = ?').get(material.id);
        if (collision) continue;
        const createdAt = now();
        db.prepare(
          `INSERT INTO api_keys (id, name, name_norm, prefix, secret_hash, created_at, created_by, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(material.id, name, nameNorm, material.prefix, material.secretHash, createdAt, input.createdBy, input.expiresAt ?? null);
        return {
          id: material.id,
          name,
          prefix: material.prefix,
          token: material.token,
          createdAt,
          createdBy: input.createdBy,
          expiresAt: input.expiresAt ?? null,
        };
      }
      throw new Error('Could not generate a unique API key id after 5 attempts');
    },

    findForAuth(id) {
      const row = db.prepare('SELECT id, secret_hash, expires_at, revoked_at, name FROM api_keys WHERE id = ?').get(id) as
        | { id: string; secret_hash: string; expires_at: number | null; revoked_at: number | null; name: string }
        | undefined;
      if (!row) return null;
      return {
        id: row.id,
        secretHash: row.secret_hash,
        status: statusOf({ expiresAt: row.expires_at === null ? null : Number(row.expires_at), revokedAt: row.revoked_at === null ? null : Number(row.revoked_at) }, now()),
        name: row.name,
      };
    },

    get(id) {
      const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id);
      return row ? rowToRecord(row, now()) : null;
    },

    list() {
      const rows = db.prepare('SELECT * FROM api_keys ORDER BY created_at ASC, id ASC').all();
      const current = now();
      return rows.map((row) => rowToRecord(row, current));
    },

    revoke(id, revokedBy) {
      const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id) as any;
      if (!row) return null;
      if (row.revoked_at !== null) {
        return { record: rowToRecord(row, now()), alreadyRevoked: true };
      }
      const revokedAt = now();
      db.prepare('UPDATE api_keys SET revoked_at = ?, revoked_by = ? WHERE id = ?').run(revokedAt, revokedBy, id);
      const updated = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id);
      return { record: rowToRecord(updated, now()), alreadyRevoked: false };
    },

    touchLastUsed(id) {
      try {
        const current = now();
        const last = lastTouchAt.get(id);
        if (last !== undefined && current - last < 60_000) return;
        lastTouchAt.set(id, current);
        db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(current, id);
      } catch {
        // Best effort: authentication must never fail because this write did.
      }
    },
  };
}
