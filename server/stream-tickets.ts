/**
 * Short-lived, single-use tickets that let `EventSource` open `GET /api/v1/events/stream` without putting the
 * API token in the URL (issue #71). `EventSource` cannot send an `Authorization` header, so a client that
 * cannot stream a `fetch` body instead trades the token, once, for a ticket that is useless anywhere else.
 *
 * The store is in memory only, per process, the same single-use pattern as the CLI's launch codes
 * (`cli/start.ts`). Restarting the server drops every outstanding ticket; given the short TTL, that is fine.
 */
import { createHash, randomBytes } from 'node:crypto';

const DEFAULT_TTL_MS = 30_000;
const MIN_TTL_MS = 1_000;
const MAX_TTL_MS = 300_000;
const DEFAULT_MAX = 1_000;

function readTtlMs(env: NodeJS.ProcessEnv): number {
  const raw = env.AGENT_VIEWER_STREAM_TICKET_TTL_MS;
  const parsed = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_TTL_MS;
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, parsed));
}

function readMax(env: NodeJS.ProcessEnv): number {
  const raw = env.AGENT_VIEWER_STREAM_TICKET_MAX;
  const parsed = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX;
  return Math.max(1, Math.floor(parsed));
}

/** `sha256(ticket)`, hex. The plain ticket is never stored, only its hash. */
export function hashTicket(ticket: string): string {
  return createHash('sha256').update(ticket).digest('hex');
}

interface StoredTicket {
  issuedAt: number;
  expiresAt: number;
  /** `sha256` of the API token at issue time, `''` in open mode. A later token rotation invalidates the ticket. */
  tokenHash: string;
}

export type IssueTicketResult =
  | { ok: true; ticket: string; issuedAt: number; expiresAt: number; ttlMs: number }
  | { ok: false };

export interface StreamTicketStore {
  /** Issues a ticket, sweeping expired ones first. `{ ok: false }` when the outstanding cap is still full. */
  issue(): IssueTicketResult;
  /**
   * Looks up, deletes and validates a ticket in one synchronous step, so two parallel requests can never both
   * consume the same ticket. Returns `true` only when the ticket existed, had not expired and was issued under
   * the API token that is current right now.
   */
  consume(ticket: string): boolean;
  /** Outstanding (not yet consumed or swept) ticket count. Exposed for tests. */
  size(): number;
}

export interface CreateStreamTicketStoreOptions {
  /** Clock, injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Returns the `sha256` hex of the current API token, or `''` when no token is configured (open mode). */
  tokenFingerprint: () => string;
  /** Environment to read `AGENT_VIEWER_STREAM_TICKET_TTL_MS` / `_MAX` from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export function createStreamTicketStore(options: CreateStreamTicketStoreOptions): StreamTicketStore {
  const now = options.now ?? Date.now;
  const env = options.env ?? process.env;
  const tickets = new Map<string, StoredTicket>();

  function sweep(currentTime: number): void {
    for (const [hash, entry] of tickets) {
      if (entry.expiresAt <= currentTime) tickets.delete(hash);
    }
  }

  return {
    issue() {
      const currentTime = now();
      sweep(currentTime);
      if (tickets.size >= readMax(env)) {
        return { ok: false };
      }
      const ticket = `avst_${randomBytes(32).toString('base64url')}`;
      const ttlMs = readTtlMs(env);
      const issuedAt = currentTime;
      const expiresAt = issuedAt + ttlMs;
      tickets.set(hashTicket(ticket), { issuedAt, expiresAt, tokenHash: options.tokenFingerprint() });
      return { ok: true, ticket, issuedAt, expiresAt, ttlMs };
    },
    consume(ticket) {
      const hash = hashTicket(ticket);
      const entry = tickets.get(hash);
      // Deleted unconditionally, before any validation, so a second parallel lookup never finds it either.
      tickets.delete(hash);
      if (!entry) return false;
      if (entry.expiresAt <= now()) return false;
      return entry.tokenHash === options.tokenFingerprint();
    },
    size() {
      return tickets.size;
    },
  };
}
