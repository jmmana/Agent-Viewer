/**
 * Default-deny route policy for `/api/v1` (issue #108). Every route declares the scope it needs in
 * `API_V1_ROUTE_SCOPES` below; a method+path not in the table needs `admin`. The table is enforced by one
 * middleware (`enforceRoutePolicy`) mounted right after authentication, rather than by a `requireScope(...)` on
 * each `app.get(...)` call, because several route groups (pricing, budgets, budget alerts) are registered from
 * their own modules: a per-route guard there would be one forgotten argument away from an unscoped admin route,
 * while here a forgotten entry can only ever make a route stricter.
 *
 * Matching mirrors Express's own non-strict routing (case-insensitive, one optional trailing slash, `:param`
 * matching exactly one non-empty segment, `HEAD` served by `GET`), so a request cannot reach a handler through a
 * path spelling this table does not recognize. Anything it does not recognize falls back to `admin` (fail closed).
 */
import express from 'express';
import { hasScope, sortedScopes, type Principal, type Scope } from './scopes';

/** `'authenticated'`: any valid credential, whatever its scopes (`whoami`). */
export type RouteRequirement = Scope | 'authenticated';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Paths are relative to the `/api/v1` mount. Keep grouped by scope; anything absent is `admin`. */
export const API_V1_ROUTE_SCOPES: ReadonlyArray<readonly [Method, string, RouteRequirement]> = [
  // ingest: writing events into the log.
  ['POST', '/events', 'ingest'],
  ['POST', '/events/batch', 'ingest'],
  ['POST', '/agents', 'ingest'],
  ['PATCH', '/agents/:agentId', 'ingest'],
  ['POST', '/runtimes', 'ingest'],
  ['POST', '/webhooks/generic', 'ingest'],

  // read: the live view and usage figures.
  ['GET', '/events', 'read'],
  ['GET', '/events/stream', 'read'],
  ['POST', '/stream-tickets', 'read'],
  ['GET', '/snapshot', 'read'],
  ['GET', '/runtimes', 'read'],
  ['GET', '/sessions', 'read'],
  ['GET', '/sessions/:sessionId', 'read'],
  ['GET', '/usage', 'read'],
  ['GET', '/usage/ledger/status', 'read'],
  ['GET', '/usage/calls', 'read'],
  ['GET', '/usage/calls/:id/estimates', 'read'],
  ['GET', '/usage/rollup', 'read'],
  ['GET', '/usage/duplicates', 'read'],
  ['GET', '/otlp/stats', 'read'],

  // audit: read-only evidence (exports, chain verification, checkpoints, the key list).
  ['GET', '/usage/export', 'audit'],
  ['GET', '/usage/export/totals', 'audit'],
  ['GET', '/audit/chain', 'audit'],
  ['GET', '/audit/verify', 'audit'],
  ['GET', '/audit/checkpoints', 'audit'],
  ['GET', '/audit/checkpoints/:id', 'audit'],
  ['GET', '/audit/bundle', 'audit'],
  ['GET', '/keys', 'audit'],
  ['GET', '/keys/:id', 'audit'],

  // any valid credential.
  ['GET', '/whoami', 'authenticated'],
  ['GET', '/auth/whoami', 'authenticated'],

  // Everything else (key management, pricing, budgets, alert delivery, retention, redaction, signed checkpoint
  // creation, and any route added later without an entry here) is `admin`.
];

function splitPath(path: string): string[] {
  const trimmed = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  return trimmed.split('/');
}

function patternMatches(pattern: string[], actual: string[]): boolean {
  if (pattern.length !== actual.length) return false;
  for (let i = 0; i < pattern.length; i++) {
    const expected = pattern[i];
    if (expected.startsWith(':')) {
      if (actual[i] === '') return false;
      continue;
    }
    if (expected.toLowerCase() !== actual[i].toLowerCase()) return false;
  }
  return true;
}

const COMPILED = API_V1_ROUTE_SCOPES.map(([method, path, requirement]) => ({ method, segments: splitPath(path), requirement }));

/** The requirement for a request to `/api/v1<path>`; `admin` for anything not in the table. */
export function scopeForRoute(method: string, path: string): RouteRequirement {
  const normalizedMethod = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
  const actual = splitPath(path);
  for (const entry of COMPILED) {
    if (entry.method === normalizedMethod && patternMatches(entry.segments, actual)) return entry.requirement;
  }
  return 'admin';
}

/** Sends the `403 insufficient_scope` response (RFC 6750 section 3.1), distinct from a `401`: the caller is
 * authenticated, just not allowed to do this. */
export function sendInsufficientScope(res: express.Response, principal: Principal | undefined, required: Scope): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('WWW-Authenticate', `Bearer error="insufficient_scope", scope="${required}"`);
  res.status(403).json({
    error: 'insufficient_scope',
    message: `This credential lacks the "${required}" scope required by this endpoint.`,
    required,
    granted: principal ? principal.granted : [],
  });
}

export interface ScopeGuardOptions {
  /** Called before any rejection is sent (the server's rejection counters). */
  onReject?: (res: express.Response) => void;
}

/** Reads the principal `requireApiToken` stored on `res.locals.principal`. */
export function principalOf(res: express.Response): Principal | undefined {
  return res.locals.principal as Principal | undefined;
}

/** Middleware: `403 insufficient_scope` unless the authenticated principal holds `required` (directly or by
 * implication), `401` if no principal was resolved at all. Must run after authentication. */
export function requireScope(required: RouteRequirement, options: ScopeGuardOptions = {}) {
  return (_req: express.Request, res: express.Response, next: express.NextFunction): void => {
    const principal = principalOf(res);
    if (!principal) {
      options.onReject?.(res);
      res.setHeader('Cache-Control', 'no-store');
      res.status(401).json({ error: 'unauthorized', message: 'Valid Bearer token required' });
      return;
    }
    if (required === 'authenticated' || hasScope(principal, required)) {
      next();
      return;
    }
    options.onReject?.(res);
    sendInsufficientScope(res, principal, required);
  };
}

export interface RoutePolicyOptions extends ScopeGuardOptions {
  /** `true` when this request legitimately reached here without a principal because a route authenticates it
   * itself (the HMAC-signed webhook). Only honored for a route whose requirement is `ingest`. */
  selfAuthenticated?: (req: express.Request) => boolean;
}

/** Mount on `/api/v1` right after authentication: looks the request up in `API_V1_ROUTE_SCOPES` and applies
 * `requireScope` with the result. */
export function enforceRoutePolicy(options: RoutePolicyOptions = {}) {
  return (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    const requirement = scopeForRoute(req.method, req.path);
    if (!principalOf(res) && requirement === 'ingest' && options.selfAuthenticated?.(req)) {
      next();
      return;
    }
    requireScope(requirement, options)(req, res, next);
  };
}

/** `whoami` body fields shared by `/api/v1/auth/whoami`. */
export function describePrincipal(principal: Principal): { keyId: string; name: string; source: 'env' | 'named'; scopes: Scope[]; effectiveScopes: Scope[] } {
  return {
    keyId: principal.keyId,
    name: principal.name,
    source: principal.source,
    scopes: principal.granted,
    effectiveScopes: sortedScopes(principal.effective),
  };
}
