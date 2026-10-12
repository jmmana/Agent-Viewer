/**
 * Scoped API keys (issue #108): what an authenticated caller may do. Extends #107's named keys
 * (`server/apiKeys.ts`) with a granted scope list per key; the bootstrap token (`AGENT_VIEWER_API_TOKEN`, which is
 * also the CLI session token `agent-viewer start` exports) is always an implicit `admin` principal, so nothing
 * changes for a deployment that never creates a named key.
 *
 * The hierarchy is deliberately tiny and fixed: `admin` implies every other scope, `audit` implies `read`, and
 * `ingest`/`read` imply nothing else. In particular `ingest` does not imply `read` (a CI token that only sends
 * events cannot read the log back) and `audit` does not imply `ingest` (an auditor cannot write into the log they
 * are auditing).
 */

export const SCOPES = ['ingest', 'read', 'audit', 'admin'] as const;
export type Scope = (typeof SCOPES)[number];

/** Least-privilege default for a key created without an explicit `scopes` list, and for every #107 key that
 * existed before this issue's migration. */
export const DEFAULT_SCOPES: readonly Scope[] = ['ingest'];

export interface Principal {
  /** `key_...` for a named key; `'env-token'` for the bootstrap/CLI session token; `'anonymous'` in open mode. */
  keyId: string;
  name: string;
  source: 'env' | 'named';
  granted: Scope[];
  effective: ReadonlySet<Scope>;
}

const IMPLIES: Record<Scope, readonly Scope[]> = {
  admin: ['ingest', 'read', 'audit'],
  audit: ['read'],
  ingest: [],
  read: [],
};

export function isScope(value: unknown): value is Scope {
  return typeof value === 'string' && (SCOPES as readonly string[]).includes(value);
}

/** The granted scopes plus everything they imply. Unknown values are ignored (fail closed: they grant nothing). */
export function effectiveScopes(granted: readonly Scope[]): ReadonlySet<Scope> {
  const result = new Set<Scope>();
  for (const scope of granted) {
    if (!isScope(scope)) continue;
    result.add(scope);
    for (const implied of IMPLIES[scope]) result.add(implied);
  }
  return result;
}

/** Effective scopes in the canonical `SCOPES` order, for stable API output. */
export function sortedScopes(scopes: Iterable<Scope>): Scope[] {
  const set = new Set(scopes);
  return SCOPES.filter((scope) => set.has(scope));
}

export class ScopeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopeValidationError';
  }
}

/** Validates a client-supplied scope list: a non-empty array of known, distinct scope names. Throws
 * `ScopeValidationError` otherwise. Returns the list in canonical order. */
export function parseScopes(input: unknown): Scope[] {
  if (!Array.isArray(input)) throw new ScopeValidationError('must be an array of scope names');
  if (input.length === 0) throw new ScopeValidationError('must not be empty');
  const seen = new Set<Scope>();
  for (const value of input) {
    if (!isScope(value)) throw new ScopeValidationError(`unknown scope ${JSON.stringify(value)}; expected one of ${SCOPES.join(', ')}`);
    if (seen.has(value)) throw new ScopeValidationError(`duplicate scope ${JSON.stringify(value)}`);
    seen.add(value);
  }
  return sortedScopes(seen);
}

/** Parses the `api_keys.scopes` column. Anything unreadable resolves to no scopes at all (fail closed), never to
 * the default: a corrupted row must not silently become an `ingest` key, let alone anything broader. */
export function parseStoredScopes(raw: unknown): Scope[] {
  if (typeof raw !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return sortedScopes(parsed.filter(isScope));
  } catch {
    return [];
  }
}

export function makePrincipal(input: { keyId: string; name: string; source: 'env' | 'named'; granted: readonly Scope[] }): Principal {
  const granted = sortedScopes(input.granted);
  return { keyId: input.keyId, name: input.name, source: input.source, granted, effective: effectiveScopes(granted) };
}

/** The bootstrap token (`AGENT_VIEWER_API_TOKEN`, or the CLI session token, which `agent-viewer start` exports
 * under that same variable). Always `admin`; there is no way to set scopes on it. */
export const ENV_TOKEN_PRINCIPAL: Principal = makePrincipal({ keyId: 'env-token', name: 'AGENT_VIEWER_API_TOKEN', source: 'env', granted: ['admin'] });

/** Open mode (no token configured, no named key presented): the API was fully open before this issue and stays
 * so, which is exactly an implicit `admin`. */
export const OPEN_MODE_PRINCIPAL: Principal = makePrincipal({ keyId: 'anonymous', name: 'anonymous', source: 'env', granted: ['admin'] });

/** A single-use stream ticket (issue #71) redeemed on `GET /api/v1/events/stream`. Minting one already requires
 * `read`, and the ticket only ever opens that one `read` route, so it carries exactly `read`. */
export const STREAM_TICKET_PRINCIPAL: Principal = makePrincipal({ keyId: 'stream-ticket', name: 'stream-ticket', source: 'env', granted: ['read'] });

export function hasScope(principal: Principal | undefined, required: Scope): boolean {
  return principal !== undefined && principal.effective.has(required);
}
