/**
 * Usage aggregates of the ingestion server: one pure reducer that adds up every `llm.usage` call (and keeps
 * `llm.failed` calls apart) by agent and by the `(provider, model)` of the call itself.
 *
 * Rules that every figure follows:
 * - Unknown is never zero. A token kind that a call did not report is counted in `unreportedCount`, and a sum
 *   stays `null` until some call reports that kind.
 * - Amounts in different currencies, or with a different `costSource`, are never added together.
 * - Nothing is priced, estimated or converted here.
 *
 * The module has no I/O, no clock and no dependency on the store, so the same code can run on live
 * ingestion, on a rebuild from stored events and in later query APIs.
 */
import type { CanonicalEvent } from '../src/integrations/canonicalContract';

export type TokenKind = 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'reasoning';
export type CostSource = 'provider-reported' | 'estimated' | 'unknown';

/** Sum of the calls that reported this token kind. `sum` is null when no call in the bucket reported it. */
export interface TokenFigure {
  sum: number | null;
  /** Calls in the bucket whose payload omitted the field (undefined, null or an invalid value). */
  unreportedCount: number;
}

/** Cost for one (currency, costSource) pair. Amounts of different pairs are never added together. */
export interface CurrencyCost {
  /** ISO 4217 code exactly as reported. */
  currency: string;
  costSource: CostSource;
  /** Convenience value, `Number(amountExact)`. */
  amount: number;
  /** Exact decimal string accumulated in fixed point (nano units), without trailing zeros. */
  amountExact: string;
  /** Calls that contributed to this pair. */
  calls: number;
}

export interface UsageBucket {
  /** Events reduced into this bucket. */
  calls: number;
  tokens: Record<TokenKind, TokenFigure>;
  /** Sorted by currency, then costSource (code-unit order). */
  byCurrency: CurrencyCost[];
  /** `costMissingCount + currencyMissingCount`. */
  costUnknownCount: number;
  /** Calls whose cost was undefined, null, negative or not finite. */
  costMissingCount: number;
  /** Calls with a valid cost but a currency that is missing or not an ISO 4217 shape (`/^[A-Z]{3}$/`). */
  currencyMissingCount: number;
  /** Smallest `event.timestamp` in the bucket (client clock). */
  firstTimestamp: number | null;
  /** Largest `event.timestamp` in the bucket (client clock). */
  lastTimestamp: number | null;
}

/** Successful calls (`llm.usage`) at the top level, failed calls (`llm.failed`) kept apart. */
export interface UsageAggregate extends UsageBucket {
  failed: UsageBucket;
}

export interface ModelUsage extends UsageAggregate {
  /** The provider of the call itself, never the agent's current provider. */
  provider: string | null;
  /** The model of the call itself, never the agent's current model. */
  model: string | null;
}

export interface AgentUsage extends UsageAggregate {
  /** `null` groups the calls without an agent (runtime or system level). */
  agentId: string | null;
  byModel: ModelUsage[];
}

export interface UsageSummary {
  schemaVersion: '1.0';
  /** `llm.usage` and `llm.failed` events applied. */
  eventsReduced: number;
  total: UsageAggregate;
  /** Sorted by provider, then model, nulls last. */
  byModel: ModelUsage[];
  /** Sorted by agentId, null last. */
  byAgent: AgentUsage[];
}

export interface LegacyUsageFields {
  tokens: { input: number; output: number; cached: number; reasoning: number };
  cost: number | null;
}

export interface UsageReducer {
  /** Applies one accepted event. Ignores every type other than llm.usage and llm.failed. */
  apply(event: CanonicalEvent): void;
  /** Returns a fresh deep copy on every call; callers can never mutate reducer state through it. */
  summary(): UsageSummary;
  /** Deprecated projections kept for the 0.x snapshot contract. */
  legacyTotals(): LegacyUsageFields;
  legacyAgent(agentId: string): LegacyUsageFields;
}

// -------------------------------------------------------------
// Call parsing
// -------------------------------------------------------------

const TOKEN_KINDS: readonly TokenKind[] = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'];

/** Payload field read for each token kind (field names of the V1 contract). */
const TOKEN_FIELDS: Record<TokenKind, string> = {
  input: 'inputTokens',
  output: 'outputTokens',
  cacheRead: 'cacheReadTokens',
  cacheWrite: 'cacheWriteTokens',
  reasoning: 'reasoningTokens',
};

const COST_SOURCES: ReadonlySet<string> = new Set<CostSource>(['provider-reported', 'estimated', 'unknown']);
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** Agent ids that name the runtime or the system, not an agent. Same rule as the store's auto-registration. */
const NON_AGENT_IDS: ReadonlySet<string> = new Set(['external-runtime', 'system']);

/**
 * Agent of an event: `agentId`, else `source` without its `agent:` prefix. Runtime and system ids, and events
 * with neither, give `null`.
 */
export function resolveEventAgentId(event: CanonicalEvent): string | null {
  const source = typeof event.source === 'string' ? event.source : '';
  const candidate = event.agentId || (source.startsWith('agent:') ? source.replace(/^agent:/, '') : undefined);
  if (typeof candidate !== 'string' || candidate.length === 0) return null;
  if (NON_AGENT_IDS.has(candidate) || candidate.startsWith('runtime:')) return null;
  return candidate;
}

type CallCost =
  | { kind: 'missing' }
  | { kind: 'currency-missing' }
  | { kind: 'priced'; currency: string; costSource: CostSource; nano: bigint };

interface ParsedCall {
  failed: boolean;
  provider: string | null;
  model: string | null;
  tokens: Record<TokenKind, number | null>;
  cost: CallCost;
  timestamp: number | null;
}

/** A token count is reported only as a non-negative safe integer (the contract's integer range). */
function readTokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function readCost(payload: Record<string, unknown>): CallCost {
  const cost = payload.cost;
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) return { kind: 'missing' };
  const currency = payload.currency;
  if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) return { kind: 'currency-missing' };
  const source = payload.costSource;
  const costSource: CostSource = typeof source === 'string' && COST_SOURCES.has(source) ? (source as CostSource) : 'unknown';
  return { kind: 'priced', currency, costSource, nano: toNanoUnits(cost) };
}

function parseCall(event: CanonicalEvent): ParsedCall {
  const payload: Record<string, unknown> =
    event.payload && typeof event.payload === 'object' ? (event.payload as Record<string, unknown>) : {};
  const tokens = {} as Record<TokenKind, number | null>;
  for (const kind of TOKEN_KINDS) {
    tokens[kind] = readTokenCount(payload[TOKEN_FIELDS[kind]]);
  }
  return {
    failed: event.type === 'llm.failed',
    provider: typeof payload.provider === 'string' ? payload.provider : null,
    model: typeof payload.model === 'string' ? payload.model : null,
    tokens,
    cost: readCost(payload),
    timestamp: typeof event.timestamp === 'number' && Number.isFinite(event.timestamp) ? event.timestamp : null,
  };
}

// -------------------------------------------------------------
// Fixed-point arithmetic (nano units, 1e-9 of the currency unit)
// -------------------------------------------------------------

const NANO_DIGITS = 9;
const NANO_PER_UNIT = 10n ** BigInt(NANO_DIGITS);

/** Expands the shortest round-trip string of a non-negative finite number (exponent form included) to digits. */
function toPlainDecimal(value: number): { integer: string; fraction: string } {
  const text = String(value);
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(text);
  if (!match) return { integer: '0', fraction: '' };
  const digits = match[1] + (match[2] ?? '');
  const point = match[1].length + Number(match[3] ?? 0);
  if (point <= 0) return { integer: '0', fraction: '0'.repeat(-point) + digits };
  if (point >= digits.length) return { integer: digits + '0'.repeat(point - digits.length), fraction: '' };
  return { integer: digits.slice(0, point), fraction: digits.slice(point) };
}

/**
 * Converts an amount to nano units: shortest decimal string of the number, rounded half-even at 9 decimals on
 * that decimal string (not on the binary value). Digits past the ninth decimal are lost here.
 */
export function toNanoUnits(value: number): bigint {
  const { integer, fraction } = toPlainDecimal(value);
  const kept = fraction.slice(0, NANO_DIGITS).padEnd(NANO_DIGITS, '0');
  const rest = fraction.slice(NANO_DIGITS);
  let nano = BigInt(integer) * NANO_PER_UNIT + BigInt(kept);
  if (rest.length > 0) {
    const first = rest.charCodeAt(0) - 48;
    const tail = /[1-9]/.test(rest.slice(1));
    const aboveHalf = first > 5 || (first === 5 && tail);
    const exactHalf = first === 5 && !tail;
    // Half-even: an exact half rounds to the even neighbour.
    if (aboveHalf || (exactHalf && nano % 2n === 1n)) nano += 1n;
  }
  return nano;
}

/** Exact decimal string of an amount in nano units, without trailing zeros (`"0.042"`, `"3"`). */
export function formatNanoUnits(nano: bigint): string {
  const integer = nano / NANO_PER_UNIT;
  const fraction = (nano % NANO_PER_UNIT).toString().padStart(NANO_DIGITS, '0').replace(/0+$/, '');
  return fraction.length > 0 ? `${integer}.${fraction}` : integer.toString();
}

// -------------------------------------------------------------
// Mutable state (never exposed)
// -------------------------------------------------------------

interface CostAccumulator {
  currency: string;
  costSource: CostSource;
  nano: bigint;
  calls: number;
}

interface BucketState {
  calls: number;
  tokens: Record<TokenKind, TokenFigure>;
  costs: Map<string, CostAccumulator>;
  costMissingCount: number;
  currencyMissingCount: number;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
}

interface AggregateState {
  ok: BucketState;
  failed: BucketState;
}

interface ModelState extends AggregateState {
  provider: string | null;
  model: string | null;
}

interface AgentState extends AggregateState {
  agentId: string | null;
  byModel: Map<string, ModelState>;
}

function createBucketState(): BucketState {
  const tokens = {} as Record<TokenKind, TokenFigure>;
  for (const kind of TOKEN_KINDS) tokens[kind] = { sum: null, unreportedCount: 0 };
  return {
    calls: 0,
    tokens,
    costs: new Map(),
    costMissingCount: 0,
    currencyMissingCount: 0,
    firstTimestamp: null,
    lastTimestamp: null,
  };
}

function createAggregateState(): AggregateState {
  return { ok: createBucketState(), failed: createBucketState() };
}

function addCall(bucket: BucketState, call: ParsedCall): void {
  bucket.calls += 1;
  for (const kind of TOKEN_KINDS) {
    const value = call.tokens[kind];
    const figure = bucket.tokens[kind];
    if (value === null) figure.unreportedCount += 1;
    else figure.sum = (figure.sum ?? 0) + value;
  }
  const cost = call.cost;
  if (cost.kind === 'missing') {
    bucket.costMissingCount += 1;
  } else if (cost.kind === 'currency-missing') {
    bucket.currencyMissingCount += 1;
  } else {
    const key = JSON.stringify([cost.currency, cost.costSource]);
    const pair = bucket.costs.get(key);
    if (pair) {
      pair.nano += cost.nano;
      pair.calls += 1;
    } else {
      bucket.costs.set(key, { currency: cost.currency, costSource: cost.costSource, nano: cost.nano, calls: 1 });
    }
  }
  if (call.timestamp !== null) {
    bucket.firstTimestamp = bucket.firstTimestamp === null ? call.timestamp : Math.min(bucket.firstTimestamp, call.timestamp);
    bucket.lastTimestamp = bucket.lastTimestamp === null ? call.timestamp : Math.max(bucket.lastTimestamp, call.timestamp);
  }
}

function addToAggregate(aggregate: AggregateState, call: ParsedCall): void {
  addCall(call.failed ? aggregate.failed : aggregate.ok, call);
}

function getOrCreate<K, V>(map: Map<K, V>, key: K, create: () => V): V {
  let value = map.get(key);
  if (value === undefined) {
    value = create();
    map.set(key, value);
  }
  return value;
}

// -------------------------------------------------------------
// Projections (always fresh objects)
// -------------------------------------------------------------

/** Plain code-unit order, identical on every host. `null` sorts last. */
function compareNullable(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

function projectBucket(bucket: BucketState): UsageBucket {
  const tokens = {} as Record<TokenKind, TokenFigure>;
  for (const kind of TOKEN_KINDS) {
    tokens[kind] = { sum: bucket.tokens[kind].sum, unreportedCount: bucket.tokens[kind].unreportedCount };
  }
  const byCurrency = Array.from(bucket.costs.values())
    .sort((a, b) => compareNullable(a.currency, b.currency) || compareNullable(a.costSource, b.costSource))
    .map((pair): CurrencyCost => {
      const amountExact = formatNanoUnits(pair.nano);
      return {
        currency: pair.currency,
        costSource: pair.costSource,
        amount: Number(amountExact),
        amountExact,
        calls: pair.calls,
      };
    });
  return {
    calls: bucket.calls,
    tokens,
    byCurrency,
    costUnknownCount: bucket.costMissingCount + bucket.currencyMissingCount,
    costMissingCount: bucket.costMissingCount,
    currencyMissingCount: bucket.currencyMissingCount,
    firstTimestamp: bucket.firstTimestamp,
    lastTimestamp: bucket.lastTimestamp,
  };
}

function projectAggregate(aggregate: AggregateState): UsageAggregate {
  return { ...projectBucket(aggregate.ok), failed: projectBucket(aggregate.failed) };
}

function projectModels(models: Map<string, ModelState>): ModelUsage[] {
  return Array.from(models.values())
    .sort((a, b) => compareNullable(a.provider, b.provider) || compareNullable(a.model, b.model))
    .map((state) => ({ provider: state.provider, model: state.model, ...projectAggregate(state) }));
}

/** Legacy single-number cost: only when every successful call reported a cost in one (currency, costSource). */
function legacyCost(bucket: BucketState): number | null {
  if (bucket.calls === 0) return null;
  if (bucket.costMissingCount + bucket.currencyMissingCount !== 0) return null;
  if (bucket.costs.size !== 1) return null;
  const [pair] = bucket.costs.values();
  return Number(formatNanoUnits(pair.nano));
}

function legacyFields(bucket: BucketState | undefined): LegacyUsageFields {
  if (!bucket) return { tokens: { input: 0, output: 0, cached: 0, reasoning: 0 }, cost: null };
  return {
    tokens: {
      input: bucket.tokens.input.sum ?? 0,
      output: bucket.tokens.output.sum ?? 0,
      cached: bucket.tokens.cacheRead.sum ?? 0,
      reasoning: bucket.tokens.reasoning.sum ?? 0,
    },
    cost: legacyCost(bucket),
  };
}

// -------------------------------------------------------------
// Reducer
// -------------------------------------------------------------

export function createUsageReducer(): UsageReducer {
  let eventsReduced = 0;
  const total = createAggregateState();
  const byModel = new Map<string, ModelState>();
  const byAgent = new Map<string, AgentState>();

  const modelKey = (call: ParsedCall) => JSON.stringify([call.provider, call.model]);
  const newModel = (call: ParsedCall) => (): ModelState => ({
    provider: call.provider,
    model: call.model,
    ...createAggregateState(),
  });

  return {
    apply(event) {
      if (event.type !== 'llm.usage' && event.type !== 'llm.failed') return;
      const call = parseCall(event);
      const agentId = resolveEventAgentId(event);

      const model = getOrCreate(byModel, modelKey(call), newModel(call));
      const agent = getOrCreate(byAgent, JSON.stringify(agentId), () => ({
        agentId,
        byModel: new Map<string, ModelState>(),
        ...createAggregateState(),
      }));
      const agentModel = getOrCreate(agent.byModel, modelKey(call), newModel(call));

      eventsReduced += 1;
      addToAggregate(total, call);
      addToAggregate(model, call);
      addToAggregate(agent, call);
      addToAggregate(agentModel, call);
    },

    summary() {
      return {
        schemaVersion: '1.0',
        eventsReduced,
        total: projectAggregate(total),
        byModel: projectModels(byModel),
        byAgent: Array.from(byAgent.values())
          .sort((a, b) => compareNullable(a.agentId, b.agentId))
          .map((state) => ({ agentId: state.agentId, ...projectAggregate(state), byModel: projectModels(state.byModel) })),
      };
    },

    legacyTotals() {
      return legacyFields(total.ok);
    },

    legacyAgent(agentId) {
      return legacyFields(byAgent.get(JSON.stringify(agentId))?.ok);
    },
  };
}
