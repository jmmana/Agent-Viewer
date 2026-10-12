/**
 * Portal REST client for server-owned pricing and budgets (issue #88, sub-issue #332): the one place the demo
 * app/portal talks to `GET/POST /api/v1/pricing*` (issue #83, `server/pricing/api.ts`) and
 * `GET/POST/PUT/DELETE /api/v1/budgets*` (issue #85, `server/budgets.ts`). The portal never computes a price,
 * a budget state or a comparison with a limit: every figure here is read straight from the server's response.
 *
 * Adaptation from issue #88's own illustrative sketch, the same kind #319 made for `budget.alert` vs #86's
 * draft: the real, shipped server does not have `PUT /pricing/models/:provider/:model` or
 * `GET /pricing/history` or `GET /budgets/state`.
 *
 *  - Writing a price is `POST /api/v1/pricing/changes` with `{ expectedVersion, reason, actor?, upserts,
 *    removals }` (`server/pricing/api.ts`); `putPricingChanges` mirrors that exactly, including the `409
 *    version_conflict` carrying `currentVersion` the issue's conflict flow (section 2) depends on.
 *  - There is no separate "history" endpoint for one row: the closest the server has is `GET
 *    /pricing/versions` (a list of version summaries) and `GET /pricing/versions/:version/diff`, both exposed
 *    here as `getPricingVersions`/`getPricingVersionDiff` for a sub-issue of #88's pricing editor to build its
 *    History drawer from.
 *  - There is no separate "budget state" endpoint: `GET /api/v1/budgets` already returns every budget's
 *    `status` (a `BudgetStatus | null`, computed server-side, `null` exactly when the budget is disabled)
 *    alongside its configuration (`server/budgets.ts`'s `BudgetView`). `getBudgets` is both "list budgets" and
 *    "read budget state" at once; there is no separate `getBudgetState` method.
 *
 * `PriceEntry`/`PriceEntryInputSchema`/`PriceEntryKeySchema` are imported from `./pricingContract`, the shared,
 * isomorphic module `server/pricing/api.ts` itself imports (its own doc comment says "server and portal both
 * import it"). Budgets have no equivalent shared, browser-safe module (`server/budgets.ts` pulls in SQLite), so
 * the budgets response shape is mirrored here with its own zod schemas, the same discipline
 * `src/integrations/ledgerClient.ts` already uses for the usage ledger's rollup/calls responses.
 *
 * Every response is validated at the boundary:
 *  - A numeric field that is `null` on the wire (`spent`, `ratio`, `limitRemaining`, every price field) stays
 *    `null`: zod's `.nullable()` never coerces it, there is no `.default(0)` anywhere in this file.
 *  - A `BudgetStatus.state` outside the four known literals (`ok | warning | exceeded | unknown`) is mapped to
 *    `'unknown'`, never `'ok'`, and logs a contract warning via `console.warn` (never throws, never silently
 *    treats a corrupt/forward-incompatible server as healthy).
 *  - A response whose top-level shape does not parse at all (wrong types, missing required fields, not valid
 *    JSON) is a `'contract'` error, distinct from every HTTP-status-derived error kind below.
 *
 * Every method returns `ServerApiResult<T>`, never throws for an HTTP or network failure: `{ ok: true, data }`
 * or `{ ok: false, kind, ... }` with `kind` one of `unauthorized | forbidden | not_found | conflict | invalid |
 * network | contract` (issue #88 section 1). A bare 5xx is folded into `'network'`: the issue's own taxonomy
 * has no separate "server error" bucket, and the UI treatment the issue asks for ("network errors keep the
 * last good data with a visible stale marker") is exactly what an unreachable/misbehaving server also needs.
 *
 * Auth is header-only (`Authorization: Bearer <token>`), never a `?token=` query parameter on any request here
 * (issue #88 section 1; the server's own `openModeGuard`, issue #71, rejects a query-string token outright).
 * `getToken` is awaited before every request, so a caller whose token is still resolving (URL fragment, launch
 * code or `sessionStorage`, see `liveConnection.ts`) never fires a request with a token that was about to
 * arrive. `POST`/`PUT` writes send an `Idempotency-Key` header (CORS already allows it); a caller may supply
 * one to keep across a retry of the exact same logical action (so a double click or a retry cannot create a
 * duplicate budget), or omit it and get a freshly generated one. The current server (#304) does not yet
 * deduplicate on this header for budgets/pricing (only event ingestion does); sending it is forward-compatible
 * and matches the CORS allowance already shipped for it.
 */
import { z } from 'zod';
import { PriceEntrySchema, type PriceEntryInput, type PriceEntryKey } from './pricingContract';

// -------------------------------------------------------------
// Shared result/error shape
// -------------------------------------------------------------

export type ServerApiErrorKind = 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'invalid' | 'network' | 'contract';

export interface ServerApiFieldIssue {
  path: string;
  message: string;
}

export interface ServerApiError {
  kind: ServerApiErrorKind;
  /** The HTTP status, when the error came from a response (absent for `network`/`contract` failures that never
   * reached a status code, e.g. a thrown fetch error or an unparsable body). */
  status?: number;
  /** The server's own `error` code (`"version_conflict"`, `"budget_not_found"`, `"admin_requires_token"`, ...),
   * when the body carried one, so a caller that needs to branch further than the broad `kind` still can. */
  code?: string;
  /** Field-level issues from a `400`/`422 validation_failed` body, when present. */
  issues?: ServerApiFieldIssue[];
  /** `currentVersion` from a pricing `409 version_conflict`, when present. */
  currentVersion?: number;
  message?: string;
}

export type ServerApiResult<T> = ({ ok: true; data: T }) | ({ ok: false } & ServerApiError);

function errorResult(error: ServerApiError): ServerApiResult<never> {
  return { ok: false, ...error };
}

// -------------------------------------------------------------
// Pricing: GET /api/v1/pricing, POST /api/v1/pricing/changes, GET /api/v1/pricing/versions[/:version/diff]
// -------------------------------------------------------------

const ValidationIssueSchema = z.object({ path: z.string(), message: z.string() });

const StarterInfoSchema = z.object({
  bundledAsOf: z.string(),
  appliedAsOf: z.string().nullable(),
  updateAvailable: z.boolean(),
});

const PricingSnapshotResponseSchema = z.object({
  schema: z.string(),
  status: z.enum(['ok', 'file_invalid', 'history_invalid']),
  issues: z.array(ValidationIssueSchema),
  pricingVersion: z.number().nullable(),
  contentHash: z.string().nullable(),
  createdAt: z.string().nullable(),
  estimated: z.boolean(),
  starter: StarterInfoSchema,
  readonly: z.boolean(),
  fileInSync: z.boolean(),
  entries: z.array(PriceEntrySchema),
});

export type PricingSnapshotResponse = z.infer<typeof PricingSnapshotResponseSchema>;

const PricingChangesResultSchema = z.object({
  changed: z.boolean(),
  pricingVersion: z.number(),
  parentVersion: z.number().nullable().optional(),
  contentHash: z.string().optional(),
  createdAt: z.string().optional(),
  fileInSync: z.boolean().optional(),
});

export type PricingChangesResult = z.infer<typeof PricingChangesResultSchema>;

export interface PutPricingChangesInput {
  expectedVersion: number;
  reason: string;
  actor?: string | null;
  upserts?: PriceEntryInput[];
  removals?: PriceEntryKey[];
}

const PricingVersionSummarySchema = z.object({
  pricingVersion: z.number(),
  createdAt: z.string(),
  origin: z.string(),
  reason: z.string(),
  actor: z.string().nullable(),
  entryCount: z.number(),
  contentHash: z.string(),
});

export type PricingVersionSummary = z.infer<typeof PricingVersionSummarySchema>;

const PricingVersionsResponseSchema = z.object({ versions: z.array(PricingVersionSummarySchema) });

const VersionDiffEntrySchema = z.object({
  key: z.object({ provider: z.string(), model: z.string(), kind: z.string(), effectiveFrom: z.string() }),
  before: PriceEntrySchema,
  after: PriceEntrySchema,
});

const PricingVersionDiffResponseSchema = z.object({
  added: z.array(PriceEntrySchema),
  removed: z.array(PriceEntrySchema),
  changed: z.array(VersionDiffEntrySchema),
});

export type PricingVersionDiffResponse = z.infer<typeof PricingVersionDiffResponseSchema>;

// -------------------------------------------------------------
// Budgets: GET/POST/PUT/DELETE /api/v1/budgets[/:id][/revisions] (server/budgets.ts; no shared browser-safe
// contract module exists for these, so the shape is mirrored here, the same way ledgerClient.ts mirrors the
// usage ledger's rollup/calls responses instead of importing server-only types).
// -------------------------------------------------------------

export const BUDGET_SCOPE_TYPES = ['all', 'agent', 'model', 'session', 'user', 'tag'] as const;
export type BudgetScopeType = (typeof BUDGET_SCOPE_TYPES)[number];

export const BUDGET_PERIODS = ['day', 'week', 'month'] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];

export const BUDGET_BASES = ['reported', 'reported_plus_estimated'] as const;
export type BudgetBasis = (typeof BUDGET_BASES)[number];

export const BUDGET_STATES = ['ok', 'warning', 'exceeded', 'unknown'] as const;
export type BudgetState = (typeof BUDGET_STATES)[number];

function isKnownBudgetState(value: unknown): value is BudgetState {
  return typeof value === 'string' && (BUDGET_STATES as readonly string[]).includes(value);
}

/** Maps an unrecognized `state` to `'unknown'` and logs a contract warning, never to `'ok'` (issue #88 section
 * 1: "an item with a state outside ok|warning|exceeded|unknown is mapped to unknown for that item"). */
const BudgetStateSchema = z.preprocess((value) => {
  if (isKnownBudgetState(value)) return value;
  // eslint-disable-next-line no-console
  console.warn(`serverApi: unrecognized budget state "${String(value)}" from the server, treating it as "unknown"`);
  return 'unknown';
}, z.enum(BUDGET_STATES));

const BudgetScopeSchema = z.object({ type: z.enum(BUDGET_SCOPE_TYPES), value: z.string().nullable() });

const BudgetCallCountsSchema = z.object({
  total: z.number(),
  withCost: z.number(),
  unknownCost: z.number(),
  otherCurrency: z.number(),
  missingCurrency: z.number(),
});

const BudgetWindowSchema = z.object({ start: z.number(), end: z.number() });

const BudgetStatusSchema = z.object({
  state: BudgetStateSchema,
  window: BudgetWindowSchema,
  spent: z.number().nullable(),
  spentComplete: z.boolean(),
  knownSpent: z.number(),
  breakdown: z.object({ reported: z.number(), estimated: z.number() }),
  containsEstimates: z.boolean(),
  limitRemaining: z.number().nullable(),
  ratio: z.number().nullable(),
  calls: BudgetCallCountsSchema,
  unknownReasons: z.array(z.string()),
  pricingVersions: z.array(z.number()),
  evaluatedAt: z.number(),
});

export type BudgetStatus = z.infer<typeof BudgetStatusSchema>;

const BudgetViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  scope: BudgetScopeSchema,
  period: z.enum(BUDGET_PERIODS),
  timezone: z.string(),
  currency: z.string(),
  basis: z.enum(BUDGET_BASES),
  limit: z.number(),
  warningRatio: z.number(),
  enabled: z.boolean(),
  revision: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
  status: BudgetStatusSchema.nullable(),
});

export type BudgetView = z.infer<typeof BudgetViewSchema>;

const BudgetsResponseSchema = z.object({
  schemaVersion: z.string(),
  generatedAt: z.number(),
  count: z.number(),
  budgets: z.array(BudgetViewSchema),
});

export type BudgetsResponse = z.infer<typeof BudgetsResponseSchema>;

export interface BudgetInput {
  id?: string;
  name: string;
  scope: { type: BudgetScopeType; value: string | null };
  period: BudgetPeriod;
  timezone?: string;
  currency: string;
  basis: BudgetBasis;
  limit: number;
  warningRatio?: number;
  enabled?: boolean;
}

const BudgetRevisionSchema = z.object({
  revision: z.number(),
  action: z.enum(['create', 'update', 'delete']),
  changedAt: z.number(),
  actor: z.string().nullable(),
  auth: z.enum(['token', 'open']),
  config: z.unknown(),
});

export type BudgetRevision = z.infer<typeof BudgetRevisionSchema>;

// -------------------------------------------------------------
// Request plumbing
// -------------------------------------------------------------

export interface CreateServerApiOptions {
  apiBase: string;
  /** Awaited before every request. Resolves to `undefined` when the server has no token configured (open
   * mode): no `Authorization` header is sent in that case, never an empty-string one. */
  getToken: () => Promise<string | undefined>;
  fetchImpl?: typeof fetch;
  /** Generates an `Idempotency-Key` for a write when the caller does not supply one. Defaults to
   * `crypto.randomUUID()`. Injectable for deterministic tests. */
  idGenerator?: () => string;
}

function trimBase(base: string): string {
  return base.replace(/\/+$/, '');
}

function errorCodeOf(body: unknown): string | undefined {
  if (body && typeof body === 'object' && typeof (body as Record<string, unknown>).error === 'string') {
    return (body as Record<string, unknown>).error as string;
  }
  return undefined;
}

function issuesOf(body: unknown): ServerApiFieldIssue[] | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const raw = (body as Record<string, unknown>).issues;
  if (!Array.isArray(raw)) return undefined;
  const parsed = z.array(ValidationIssueSchema).safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

function currentVersionOf(body: unknown): number | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const raw = (body as Record<string, unknown>).currentVersion;
  return typeof raw === 'number' ? raw : undefined;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  /** `true` sends an `Idempotency-Key` header (generated when `idempotencyKey` is not supplied). */
  idempotent?: boolean;
  idempotencyKey?: string;
  /** `true` accepts a `204 No Content` as success with `data: null`, skipping JSON parsing entirely. */
  allowNoContent?: boolean;
}

export function createServerApi(options: CreateServerApiOptions) {
  const base = trimBase(options.apiBase);
  const fetchImpl = options.fetchImpl ?? fetch;
  const idGenerator = options.idGenerator ?? (() => crypto.randomUUID());

  async function request<T>(path: string, schema: z.ZodType<T>, requestOptions: RequestOptions = {}): Promise<ServerApiResult<T>> {
    const token = await options.getToken();
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (requestOptions.body !== undefined) headers['Content-Type'] = 'application/json';
    if (requestOptions.idempotent) headers['Idempotency-Key'] = requestOptions.idempotencyKey ?? idGenerator();

    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method: requestOptions.method ?? 'GET',
        headers,
        body: requestOptions.body !== undefined ? JSON.stringify(requestOptions.body) : undefined,
        cache: 'no-store',
      });
    } catch (error) {
      return errorResult({ kind: 'network', message: error instanceof Error ? error.message : 'Network request failed' });
    }

    if (response.status === 204 && requestOptions.allowNoContent) {
      return { ok: true, data: null as T };
    }

    let json: unknown;
    try {
      json = response.status === 204 ? null : await response.json();
    } catch {
      return errorResult({ kind: 'contract', status: response.status, message: 'Response was not valid JSON' });
    }

    if (response.status === 401) return errorResult({ kind: 'unauthorized', status: 401, code: errorCodeOf(json) });
    if (response.status === 403) return errorResult({ kind: 'forbidden', status: 403, code: errorCodeOf(json) });
    if (response.status === 404) return errorResult({ kind: 'not_found', status: 404, code: errorCodeOf(json) });
    if (response.status === 409) {
      return errorResult({ kind: 'conflict', status: 409, code: errorCodeOf(json), currentVersion: currentVersionOf(json) });
    }
    if (response.status === 400 || response.status === 422) {
      return errorResult({ kind: 'invalid', status: response.status, code: errorCodeOf(json), issues: issuesOf(json) });
    }
    if (!response.ok) {
      // No dedicated bucket for a 5xx in issue #88's taxonomy; treated like an unreachable server (see module
      // doc comment), so the UI keeps the last good data and shows a stale marker instead of an error page.
      return errorResult({ kind: 'network', status: response.status, message: `Request failed with status ${response.status}` });
    }

    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      return errorResult({ kind: 'contract', status: response.status, message: 'Response did not match the expected shape' });
    }
    return { ok: true, data: parsed.data };
  }

  return {
    // --- Pricing ---------------------------------------------------
    getPricing: (): Promise<ServerApiResult<PricingSnapshotResponse>> =>
      request('/api/v1/pricing', PricingSnapshotResponseSchema),

    putPricingChanges: (
      input: PutPricingChangesInput,
      writeOptions?: { idempotencyKey?: string },
    ): Promise<ServerApiResult<PricingChangesResult>> =>
      request('/api/v1/pricing/changes', PricingChangesResultSchema, {
        method: 'POST',
        body: {
          expectedVersion: input.expectedVersion,
          reason: input.reason,
          actor: input.actor ?? null,
          upserts: input.upserts ?? [],
          removals: input.removals ?? [],
        },
        idempotent: true,
        idempotencyKey: writeOptions?.idempotencyKey,
      }),

    getPricingVersions: (params?: { limit?: number; beforeVersion?: number }): Promise<ServerApiResult<{ versions: PricingVersionSummary[] }>> => {
      const search = new URLSearchParams();
      if (params?.limit !== undefined) search.set('limit', String(params.limit));
      if (params?.beforeVersion !== undefined) search.set('beforeVersion', String(params.beforeVersion));
      const query = search.toString();
      return request(`/api/v1/pricing/versions${query ? `?${query}` : ''}`, PricingVersionsResponseSchema);
    },

    getPricingVersionDiff: (version: number, against: number): Promise<ServerApiResult<PricingVersionDiffResponse>> =>
      request(`/api/v1/pricing/versions/${version}/diff?against=${against}`, PricingVersionDiffResponseSchema),

    // --- Budgets -----------------------------------------------------
    getBudgets: (params?: { state?: BudgetState; scopeType?: BudgetScopeType; scopeValue?: string }): Promise<ServerApiResult<BudgetsResponse>> => {
      const search = new URLSearchParams();
      if (params?.state !== undefined) search.set('state', params.state);
      if (params?.scopeType !== undefined) search.set('scopeType', params.scopeType);
      if (params?.scopeValue !== undefined) search.set('scopeValue', params.scopeValue);
      const query = search.toString();
      return request(`/api/v1/budgets${query ? `?${query}` : ''}`, BudgetsResponseSchema);
    },

    getBudget: (id: string): Promise<ServerApiResult<BudgetView>> => request(`/api/v1/budgets/${encodeURIComponent(id)}`, BudgetViewSchema),

    createBudget: (input: BudgetInput, writeOptions?: { idempotencyKey?: string }): Promise<ServerApiResult<BudgetView>> =>
      request('/api/v1/budgets', BudgetViewSchema, {
        method: 'POST',
        body: input,
        idempotent: true,
        idempotencyKey: writeOptions?.idempotencyKey,
      }),

    putBudget: (id: string, input: BudgetInput, writeOptions?: { idempotencyKey?: string }): Promise<ServerApiResult<BudgetView>> =>
      request(`/api/v1/budgets/${encodeURIComponent(id)}`, BudgetViewSchema, {
        method: 'PUT',
        body: input,
        idempotent: true,
        idempotencyKey: writeOptions?.idempotencyKey,
      }),

    deleteBudget: (id: string): Promise<ServerApiResult<null>> =>
      request(`/api/v1/budgets/${encodeURIComponent(id)}`, z.null(), { method: 'DELETE', allowNoContent: true }),

    getBudgetRevisions: (id: string): Promise<ServerApiResult<BudgetRevision[]>> =>
      request(`/api/v1/budgets/${encodeURIComponent(id)}/revisions`, z.array(BudgetRevisionSchema)),
  };
}

export type ServerApi = ReturnType<typeof createServerApi>;
