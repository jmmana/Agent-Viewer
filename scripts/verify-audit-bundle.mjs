#!/usr/bin/env node
// Standalone, zero-dependency verifier for an Agent Viewer offline audit bundle (issue #401, sub-issue of #110).
//
// Only Node built-ins: node:crypto, node:zlib, node:fs, node:readline. No import from src/ or server/: the
// canonical hash function (#105), the checkpoint signed-payload format (#106/#387), the pricing content digest
// and cost-estimate formula (#83/#84) are all reimplemented below, independently, on purpose, so this one file
// can be copied to an air-gapped machine and run against a downloaded bundle with nothing else installed.
//
// Usage:
//   node verify-audit-bundle.mjs <bundle.avbundle.jsonl[.gz]>
//     [--trusted-key <sha256:fingerprint | pem-file>]
//     [--expect-checkpoint <seq>:<headHash>]
//     [--require-complete] [--json]
//
// Exit codes (precedence 2, then 1, then 3, then 0):
//   0 pass      every check passed and every signing key matched --trusted-key (and --require-complete, if given)
//   1 fail      at least one check failed
//   2 invalid   unreadable file, malformed JSON line, missing/duplicate header or footer, unsupported formatVersion
//   3 unpinned  integrity checks pass but no --trusted-key was given (or a key did not match it)

import { createReadStream, readFileSync, openSync, readSync, closeSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import crypto from 'node:crypto';

// -------------------------------------------------------------
// Reimplemented primitives (must stay byte-identical to the server's own; see tests/audit-bundle-vectors.test.mjs)
// -------------------------------------------------------------

const EVENT_HASH_DOMAIN = 'agent-viewer/chain/v1';
const CHECKPOINT_SIGNED_DOMAIN_LINE = 'agent-viewer/checkpoint/v1\n';

function hasLoneSurrogate(value) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function serializeString(value) {
  if (hasLoneSurrogate(value)) throw new TypeError('canonicalize: unpaired UTF-16 surrogate');
  return JSON.stringify(value);
}

function serialize(value, ancestors) {
  if (typeof value === 'function' || typeof value === 'symbol') throw new TypeError('canonicalize: not representable in JSON');
  if (typeof value === 'bigint') throw new TypeError('canonicalize: BigInt is not representable in JSON');
  if (value === null) return 'null';
  switch (typeof value) {
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalize: NaN/Infinity not representable');
      return JSON.stringify(value);
    case 'string':
      return serializeString(value);
    case 'boolean':
      return value ? 'true' : 'false';
    default:
      break;
  }
  const object = value;
  if (ancestors.has(object)) throw new TypeError('canonicalize: circular structure');
  ancestors.add(object);
  try {
    if (Array.isArray(object)) {
      return `[${object.map((item) => (item === undefined ? 'null' : serialize(item, ancestors))).join(',')}]`;
    }
    const record = object;
    const members = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${serializeString(key)}:${serialize(record[key], ancestors)}`);
    return `{${members.join(',')}}`;
  } finally {
    ancestors.delete(object);
  }
}

/** RFC 8785 JSON Canonicalization Scheme, byte-identical to `server/chain.ts`'s `canonicalize`. */
function canonicalize(value) {
  if (value === undefined) throw new TypeError('canonicalize: undefined is not representable in JSON');
  return serialize(value, new Set());
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Byte-identical to `server/chain.ts`'s `eventHash`. */
function eventHash({ seq, prevHash, receivedAt, submitterId, event }) {
  return sha256Hex(canonicalize([EVENT_HASH_DOMAIN, seq, prevHash, receivedAt, submitterId, event]));
}

/** Byte-identical to `server/audit/checkpointFormat.ts`'s `checkpointSignedBytes`/`checkpointDigest`. */
function checkpointSignedBytes(body) {
  return Buffer.from(CHECKPOINT_SIGNED_DOMAIN_LINE + canonicalize(body), 'utf8');
}

function checkpointDigest(body) {
  return crypto.createHash('sha256').update(checkpointSignedBytes(body)).digest('hex');
}

/** Byte-identical to `server/audit/checkpointFormat.ts`'s `verifyCheckpointSignature`, taking a PEM string. */
function verifyCheckpointSignature(body, signatureB64, publicKeyPem) {
  try {
    const publicKey = crypto.createPublicKey(publicKeyPem);
    if (publicKey.asymmetricKeyType !== 'ed25519') return false;
    const signature = Buffer.from(signatureB64, 'base64');
    if (signature.length !== 64 || signature.toString('base64') !== signatureB64) return false;
    return crypto.verify(null, checkpointSignedBytes(body), publicKey, signature);
  } catch {
    return false;
  }
}

/** `ed25519:` + lowercase hex SHA-256 of the SPKI DER encoding, matching `server/audit/checkpointFormat.ts`'s
 * `keyIdFor`, derived here from a PEM string instead of a `KeyObject` the caller already has. */
function keyFingerprintFromPem(publicKeyPem) {
  const publicKey = crypto.createPublicKey(publicKeyPem);
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return `ed25519:${crypto.createHash('sha256').update(der).digest('hex')}`;
}

// Pricing: byte-identical to `src/integrations/pricingContract.ts`'s `canonicalEntryObject`/`computeContentHash`.
const PRICE_ENTRY_KEYS = [
  'aliases', 'cacheReadPerMillion', 'cacheWritePerMillion', 'currency', 'effectiveFrom', 'estimated',
  'inputPerMillion', 'kind', 'model', 'note', 'outputPerMillion', 'provider', 'reasoningBilling',
  'reasoningPerMillion', 'source', 'sourceCheckedAt', 'sourceUrl',
];

function canonicalEntryObject(entry) {
  // Matches `src/integrations/pricingContract.ts`'s own `canonicalEntryObject` exactly: a field left `undefined`
  // on `entry` stays `undefined` here too, so `JSON.stringify` below omits that key entirely, the same as it
  // does for the original. Coercing it to an explicit `null` instead (as an earlier version of this port did)
  // changes the serialized bytes and produces a different digest for the same entry.
  const out = {};
  for (const key of PRICE_ENTRY_KEYS) out[key] = entry[key];
  return out;
}

function sortPriceEntries(entries) {
  return [...entries].sort((a, b) => {
    if (a.provider !== b.provider) return a.provider < b.provider ? -1 : 1;
    if (a.model !== b.model) return a.model < b.model ? -1 : 1;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    if (a.effectiveFrom !== b.effectiveFrom) return a.effectiveFrom < b.effectiveFrom ? -1 : 1;
    return 0;
  });
}

/** Byte-identical to `src/integrations/pricingContract.ts`'s `computeContentHash`. */
function computeContentHash(entries) {
  const canonical = sortPriceEntries(entries).map(canonicalEntryObject);
  return `sha256:${sha256Hex(JSON.stringify(canonical))}`;
}

/** Byte-identical to `src/integrations/pricingContract.ts`'s `resolvePrice`. */
function resolvePrice(entries, query) {
  const provider = query.provider.trim().toLowerCase();
  const modelId = query.model.trim().toLowerCase();
  const atMs = typeof query.at === 'number' ? query.at : Date.parse(query.at);
  if (Number.isNaN(atMs)) return null;
  const providerEntries = entries.filter((entry) => entry.provider === provider);
  if (providerEntries.length === 0) return null;
  const canonicalModel = providerEntries.some((entry) => entry.model === modelId)
    ? modelId
    : (providerEntries.find((entry) => entry.aliases.includes(modelId))?.model ?? null);
  if (canonicalModel === null) return null;
  const candidates = providerEntries.filter((entry) => entry.model === canonicalModel && Date.parse(entry.effectiveFrom) <= atMs);
  if (candidates.length === 0) return null;
  const overrides = candidates.filter((entry) => entry.kind === 'override');
  const pool = overrides.length > 0 ? overrides : candidates.filter((entry) => entry.kind === 'list');
  if (pool.length === 0) return null;
  return pool.reduce((latest, entry) => (Date.parse(entry.effectiveFrom) > Date.parse(latest.effectiveFrom) ? entry : latest));
}

function divRoundHalfEven(numerator, denominator) {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const twiceRemainder = remainder * 2n;
  if (twiceRemainder < denominator) return quotient;
  if (twiceRemainder > denominator) return quotient + 1n;
  return quotient % 2n === 0n ? quotient : quotient + 1n;
}

function ratePerMillionToNano(rate) {
  return BigInt(Math.round(rate * 1_000_000_000));
}

const MAX_SAFE_NANO = BigInt(Number.MAX_SAFE_INTEGER);

/** Byte-identical to `server/pricing/estimate.ts`'s `tableKnowsModel`: tells "the model is not in the table at
 * all" (`no_price_for_model`) apart from "the model is in the table, but nothing is effective yet"
 * (`no_price_in_force`), mirroring `resolvePrice`'s own provider/model/alias matching without its date filter. */
function tableKnowsModel(entries, provider, model) {
  const normalizedProvider = provider.trim().toLowerCase();
  const normalizedModel = model.trim().toLowerCase();
  const providerEntries = entries.filter((entry) => entry.provider === normalizedProvider);
  if (providerEntries.length === 0) return false;
  return providerEntries.some((entry) => entry.model === normalizedModel || entry.aliases.includes(normalizedModel));
}

/** Byte-identical to `server/pricing/estimate.ts`'s `estimateCall`: returns `{ costNano, currency, status }`. */
function estimateCall(row, pricing) {
  try {
    if (row.provider === null || row.model === null) return { costNano: null, currency: null, status: 'no_price_for_model' };
    if (pricing.pricingVersion === null) return { costNano: null, currency: null, status: 'no_price_in_force' };
    const entry = resolvePrice(pricing.entries, { provider: row.provider, model: row.model, at: row.occurredAt });
    if (!entry) {
      const known = tableKnowsModel(pricing.entries, row.provider, row.model);
      return { costNano: null, currency: null, status: known ? 'no_price_in_force' : 'no_price_for_model' };
    }
    if (row.inputTokens === null || row.outputTokens === null || row.cacheReadTokens === null || row.cacheWriteTokens === null) {
      return { costNano: null, currency: null, status: 'missing_usage' };
    }
    const reasoningNeeded = entry.reasoningBilling === 'separate';
    if (reasoningNeeded && row.reasoningTokens === null) return { costNano: null, currency: null, status: 'missing_usage' };
    const uncachedInput = row.inputTokens - row.cacheReadTokens - row.cacheWriteTokens;
    if (uncachedInput < 0) return { costNano: null, currency: null, status: 'inconsistent_usage' };
    const components = [
      { tokens: uncachedInput, ratePerMillion: entry.inputPerMillion },
      { tokens: row.outputTokens, ratePerMillion: entry.outputPerMillion },
      { tokens: row.cacheReadTokens, ratePerMillion: entry.cacheReadPerMillion },
      { tokens: row.cacheWriteTokens, ratePerMillion: entry.cacheWritePerMillion },
    ];
    if (reasoningNeeded) components.push({ tokens: row.reasoningTokens, ratePerMillion: entry.reasoningPerMillion });
    if (components.some((c) => c.tokens > 0 && c.ratePerMillion === null)) return { costNano: null, currency: null, status: 'no_price_for_component' };
    let scaledSum = 0n;
    for (const component of components) {
      if (component.tokens === 0 || component.ratePerMillion === null) continue;
      scaledSum += BigInt(component.tokens) * ratePerMillionToNano(component.ratePerMillion);
    }
    const costNano = divRoundHalfEven(scaledSum, 1_000_000n);
    if (costNano > MAX_SAFE_NANO) return { costNano: null, currency: null, status: 'failed' };
    return { costNano: Number(costNano), currency: entry.currency, status: 'estimated' };
  } catch {
    return { costNano: null, currency: null, status: 'failed' };
  }
}

function nanoToDecimalCost(nano) {
  // Exact fixed-point division by 1e9, matching `server/usageAggregates.ts`'s `formatNanoUnits` for this module's
  // one caller shape (a non-negative integer nano value): format as an integer string, insert the decimal point.
  const n = BigInt(Math.round(nano));
  const negative = n < 0n;
  const abs = negative ? -n : n;
  const str = abs.toString().padStart(10, '0');
  const whole = str.slice(0, -9);
  const frac = str.slice(-9).replace(/0+$/, '');
  const text = frac.length > 0 ? `${whole}.${frac}` : whole;
  return Number(negative ? `-${text}` : text);
}

// -------------------------------------------------------------
// Bundle streaming and the 9 checks
// -------------------------------------------------------------

const FORMAT_VERSION = 1;
const MAX_LINE_BYTES = 8 * 1024 * 1024;

function newCheck(id) {
  return { id, ok: true, detail: null };
}

/** Verification state, built incrementally as lines stream in, finalized once the stream ends. */
function createVerifierState(opts) {
  return {
    opts,
    checks: {
      FORMAT: newCheck('FORMAT'),
      CHAIN: newCheck('CHAIN'),
      CHECKPOINTS: newCheck('CHECKPOINTS'),
      KEY: newCheck('KEY'),
      LEDGER: newCheck('LEDGER'),
      PRICING: newCheck('PRICING'),
      TOTALS: newCheck('TOTALS'),
      REDACTION: newCheck('REDACTION'),
      EXPECT: newCheck('EXPECT'),
    },
    warnings: [],
    firstFailure: null,
    header: null,
    footerSeen: false,
    footer: null,
    lineIndex: 0,
    sectionPhase: 'header', // header -> body (key/pricing/checkpoint/tombstone) -> events -> footer
    seenKindsInBody: new Set(),
    keysByKeyId: new Map(),
    pricingByVersion: new Map(),
    checkpoints: [],
    tombstonesBySeq: new Map(),
    auditEventPayloadsBySeq: new Map(),
    hashBySeq: new Map(),
    lastEventHash: null, // chain head hash as the walk progresses; starts at header.range.prevHash
    pendingLedgerFor: null, // event id awaiting its ledger line, or null
    counts: { events: 0, ledger: 0, checkpoints: 0, tombstones: 0, pricing: 0 },
    totals: null, // FooterTotalsAccumulator, created once header is known
    hashStream: crypto.createHash('sha256'),
    tamperedTombstoneIds: new Set(),
  };
}

function fail(state, checkId, seq, message) {
  const check = state.checks[checkId];
  if (check.ok) {
    check.ok = false;
    check.detail = message;
  }
  if (!state.firstFailure) state.firstFailure = { check: checkId, seq: seq ?? null, message };
}

function newTokenTotal() {
  return { sum: null, knownCalls: 0, unknownCalls: 0 };
}

function addToken(total, value) {
  if (value === null || value === undefined) {
    total.unknownCalls++;
    return;
  }
  total.knownCalls++;
  total.sum = total.sum === null ? value : total.sum + value;
}

class CostTotals {
  constructor() {
    this.groups = new Map();
  }
  add(currency, cost) {
    let group = this.groups.get(currency ?? null);
    if (!group) {
      group = { currency: currency ?? null, knownCalls: 0, unknownCalls: 0, cost: null };
      this.groups.set(currency ?? null, group);
    }
    if (cost === null || cost === undefined) {
      group.unknownCalls++;
    } else {
      group.knownCalls++;
      group.cost = group.cost === null ? cost : group.cost + cost;
    }
  }
  toArray() {
    return [...this.groups.values()].sort((a, b) => {
      if (a.currency === null) return b.currency === null ? 0 : 1;
      if (b.currency === null) return -1;
      return a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0;
    });
  }
}

function newFooterAccumulator() {
  return {
    calls: 0,
    callsByStatus: {},
    tokens: {
      inputTokens: newTokenTotal(),
      outputTokens: newTokenTotal(),
      cacheReadTokens: newTokenTotal(),
      cacheWriteTokens: newTokenTotal(),
      reasoningTokens: newTokenTotal(),
    },
    reportedCost: new CostTotals(),
    estimatedCost: new CostTotals(),
    add(ledgerLine) {
      this.calls++;
      this.callsByStatus[ledgerLine.status] = (this.callsByStatus[ledgerLine.status] ?? 0) + 1;
      addToken(this.tokens.inputTokens, ledgerLine.inputTokens);
      addToken(this.tokens.outputTokens, ledgerLine.outputTokens);
      addToken(this.tokens.cacheReadTokens, ledgerLine.cacheReadTokens);
      addToken(this.tokens.cacheWriteTokens, ledgerLine.cacheWriteTokens);
      addToken(this.tokens.reasoningTokens, ledgerLine.reasoningTokens);
      this.reportedCost.add(ledgerLine.currency, ledgerLine.cost);
      this.estimatedCost.add(ledgerLine.estimatedCurrency, ledgerLine.estimatedCost);
    },
    toJSON() {
      return {
        calls: this.calls,
        callsByStatus: this.callsByStatus,
        tokens: this.tokens,
        reportedCost: this.reportedCost.toArray(),
        estimatedCost: this.estimatedCost.toArray(),
      };
    },
  };
}

function deepEqualNumberSafe(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Processes one already-JSON.parsed bundle line. Throws only for a structural `invalid` condition (handled by
 * the caller as exit code 2); every tamper/mismatch is recorded as a check failure instead. */
function processLine(state, obj, rawLineLength) {
  state.lineIndex++;
  if (rawLineLength > MAX_LINE_BYTES) {
    throw new InvalidBundleError(`line ${state.lineIndex} exceeds the ${MAX_LINE_BYTES}-byte limit`);
  }
  if (!obj || typeof obj !== 'object' || typeof obj.kind !== 'string') {
    throw new InvalidBundleError(`line ${state.lineIndex} has no recognizable "kind"`);
  }

  if (state.footerSeen) {
    // Junk appended after the footer (issue #110's tamper matrix: "Junk appended after the footer" -> FORMAT,
    // exit 1, not an outright "invalid" exit 2): the bundle otherwise parsed and finalized fine, so this is a
    // content-integrity problem, not a structural one. A second footer line is the same case.
    fail(state, 'FORMAT', null, obj.kind === 'footer' ? 'more than one footer line' : 'content appears after the footer line');
    return;
  }

  if (obj.kind === 'footer') {
    if (state.header === null) throw new InvalidBundleError('footer appeared before header');
    state.footerSeen = true;
    state.footer = obj;
    finalizeFooterComparison(state);
    return;
  }

  if (obj.kind === 'header') {
    if (state.header !== null) throw new InvalidBundleError('more than one header line');
    state.header = obj;
    if (obj.format !== 'agent-viewer-audit-bundle') fail(state, 'FORMAT', null, 'header.format is not "agent-viewer-audit-bundle"');
    if (obj.formatVersion !== FORMAT_VERSION) {
      throw new InvalidBundleError(`unsupported formatVersion ${JSON.stringify(obj.formatVersion)} (this verifier understands ${FORMAT_VERSION})`);
    }
    state.lastEventHash = obj.range?.prevHash ?? null;
    state.totals = newFooterAccumulator();
    return;
  }
  if (state.header === null) throw new InvalidBundleError(`line ${state.lineIndex} ("${obj.kind}") appeared before the header`);

  // Section-order enforcement: key* / pricing* / checkpoint* / tombstone*, then event(+ledger)*.
  const bodyOrder = ['key', 'pricing', 'checkpoint', 'tombstone'];
  if (bodyOrder.includes(obj.kind)) {
    if (state.sectionPhase === 'events') fail(state, 'FORMAT', state.lineIndex, `"${obj.kind}" line appeared after events started`);
    const idx = bodyOrder.indexOf(obj.kind);
    for (const seen of state.seenKindsInBody) {
      if (bodyOrder.indexOf(seen) > idx) {
        fail(state, 'FORMAT', state.lineIndex, `"${obj.kind}" line appeared after a "${seen}" line (wrong section order)`);
        break;
      }
    }
    state.seenKindsInBody.add(obj.kind);
  } else if (obj.kind === 'event' || obj.kind === 'ledger') {
    state.sectionPhase = 'events';
  }

  switch (obj.kind) {
    case 'key': {
      state.keysByKeyId.set(obj.keyId, obj);
      if (state.opts.trustedKeyFingerprint) {
        let fingerprint = null;
        try {
          fingerprint = keyFingerprintFromPem(obj.publicKeyPem);
        } catch {
          fail(state, 'KEY', null, `key ${obj.keyId}: publicKeyPem could not be parsed`);
          break;
        }
        if (fingerprint !== state.opts.trustedKeyFingerprint) {
          fail(state, 'KEY', null, `key ${obj.keyId} (fingerprint ${fingerprint}) does not match --trusted-key`);
        }
      }
      break;
    }
    case 'pricing': {
      state.counts.pricing++;
      const recomputedDigest = computeContentHash(obj.entries ?? []);
      if (recomputedDigest !== obj.digest) {
        fail(state, 'PRICING', null, `pricing version ${obj.pricingVersion}: digest does not match its own entries`);
      }
      state.pricingByVersion.set(obj.pricingVersion, obj);
      break;
    }
    case 'checkpoint': {
      state.counts.checkpoints++;
      verifyCheckpointLine(state, obj);
      state.checkpoints.push(obj);
      break;
    }
    case 'tombstone': {
      state.counts.tombstones++;
      state.tombstonesBySeq.set(obj.seq, obj);
      break;
    }
    case 'event': {
      verifyEventLine(state, obj);
      break;
    }
    case 'ledger': {
      verifyLedgerLine(state, obj);
      break;
    }
    default:
      // Unknown kinds are ignored (forward-compatible within a known formatVersion), per issue #110's
      // versioning rule: "the verifier ... ignores unknown fields on bundle records inside a known major".
      break;
  }
}

class InvalidBundleError extends Error {}

function verifyEventLine(state, obj) {
  state.counts.events++;
  if (state.pendingLedgerFor) {
    fail(state, 'LEDGER', obj.seq, `event ${state.pendingLedgerFor} (llm.usage/llm.failed) was never followed by its ledger row`);
    state.pendingLedgerFor = null;
  }

  const eventId = obj.event && typeof obj.event === 'object' ? obj.event.id : undefined;
  const eventType = obj.event && typeof obj.event === 'object' ? obj.event.type : undefined;

  if (obj.prevHash !== state.lastEventHash) {
    fail(state, 'CHAIN', obj.seq, `prevHash at seq ${obj.seq} does not match the previous chained row's hash`);
  }

  // A tombstone line's own `seq` is the tombstoned event's seq (bundle.ts: `seq: Number(row.seq)` of the event
  // row itself), so a direct lookup is exact; tombstone lines always precede the event lines in the bundle.
  const isTombstoned = state.tombstonesBySeq.has(obj.seq);
  if (!isTombstoned) {
    let recomputed;
    try {
      recomputed = eventHash({ seq: obj.seq, prevHash: obj.prevHash ?? '', receivedAt: obj.receivedAt, submitterId: obj.submitterId ?? '', event: obj.event });
    } catch (error) {
      fail(state, 'CHAIN', obj.seq, `event at seq ${obj.seq} could not be canonicalized: ${error instanceof Error ? error.message : String(error)}`);
      recomputed = null;
    }
    if (recomputed !== null && recomputed !== obj.hash) {
      fail(state, 'CHAIN', obj.seq, `recomputed hash does not match the stored hash at seq ${obj.seq}`);
    }
  }
  // A tombstoned row's own stored hash is trusted here structurally (it is not recomputable from the current,
  // redacted event content by design); REDACTION cross-checks it against the audit event that committed it.

  state.lastEventHash = obj.hash;
  state.hashBySeq.set(obj.seq, obj.hash);

  if (typeof eventType === 'string' && eventType.startsWith('audit.')) {
    state.auditEventPayloadsBySeq.set(obj.seq, obj.event);
  }

  if (eventType === 'llm.usage' || eventType === 'llm.failed') {
    state.pendingLedgerFor = eventId ?? null;
    state.pendingLedgerExpectedSeq = obj.seq;
    state.pendingLedgerPayload = obj.event?.payload ?? {};
    state.pendingLedgerEventType = eventType;
  }
}

function verifyLedgerLine(state, obj) {
  state.counts.ledger++;
  if (!state.pendingLedgerFor || obj.eventId !== state.pendingLedgerFor) {
    fail(state, 'LEDGER', null, `ledger row for ${obj.eventId} does not directly follow a matching llm.usage/llm.failed event`);
  } else {
    const payload = state.pendingLedgerPayload;
    if (payload.provider !== undefined && obj.provider !== null && payload.provider !== obj.provider) {
      fail(state, 'LEDGER', obj.ledgerSeq, `ledger row for ${obj.eventId}: provider does not match its event's payload`);
    }
    if (payload.model !== undefined && obj.model !== null && payload.model !== obj.model) {
      fail(state, 'LEDGER', obj.ledgerSeq, `ledger row for ${obj.eventId}: model does not match its event's payload`);
    }
    const expectedStatus = state.pendingLedgerEventType === 'llm.usage' ? 'ok' : (payload.errorKind ?? null);
    if (expectedStatus !== null && obj.status !== expectedStatus) {
      fail(state, 'LEDGER', obj.ledgerSeq, `ledger row for ${obj.eventId}: status "${obj.status}" does not match the expected "${expectedStatus}"`);
    }
    // Token fields: compared against the event's own payload so an edited ledger token count (including a
    // `null` changed to `0`, which "provider/model agree" alone would never catch) fails LEDGER directly, here,
    // rather than only showing up later as a TOTALS mismatch once the footer is reached.
    for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
      if (payload[field] === undefined) continue;
      if (!deepEqualNumberSafe(payload[field], obj[field])) {
        fail(state, 'LEDGER', obj.ledgerSeq, `ledger row for ${obj.eventId}: ${field} (${JSON.stringify(obj[field])}) does not match its event's payload (${JSON.stringify(payload[field])})`);
      }
    }
  }
  state.pendingLedgerFor = null;

  if (obj.pricingVersion !== null && obj.pricingVersion !== undefined) {
    const pricing = state.pricingByVersion.get(obj.pricingVersion);
    if (!pricing) {
      fail(state, 'PRICING', null, `ledger row ${obj.eventId} references pricingVersion ${obj.pricingVersion}, which has no "pricing" line in this bundle`);
    } else {
      const occurredAtMs = Date.parse(obj.occurredAt);
      const result = estimateCall(
        {
          provider: obj.provider,
          model: obj.model,
          occurredAt: occurredAtMs,
          inputTokens: obj.inputTokens,
          outputTokens: obj.outputTokens,
          cacheReadTokens: obj.cacheReadTokens,
          cacheWriteTokens: obj.cacheWriteTokens,
          reasoningTokens: obj.reasoningTokens,
        },
        { pricingVersion: pricing.pricingVersion, entries: pricing.entries ?? [] }
      );
      const recomputedCost = result.costNano === null ? null : nanoToDecimalCost(result.costNano);
      if (!deepEqualNumberSafe(recomputedCost, obj.estimatedCost)) {
        fail(state, 'PRICING', null, `ledger row ${obj.eventId}: recomputed estimatedCost (${recomputedCost}) does not match the bundle's (${obj.estimatedCost})`);
      }
    }
  }

  state.totals.add(obj);
}

function verifyCheckpointLine(state, obj) {
  const key = state.keysByKeyId.get(obj.body?.keyId);
  if (!key) {
    fail(state, 'CHECKPOINTS', obj.body?.checkpointSeq, `checkpoint ${obj.body?.checkpointSeq}: signing key ${obj.body?.keyId} has no "key" line in this bundle`);
  } else if (!verifyCheckpointSignature(obj.body, obj.signature, key.publicKeyPem)) {
    fail(state, 'CHECKPOINTS', obj.body?.checkpointSeq, `checkpoint ${obj.body?.checkpointSeq}: signature is invalid`);
  }
  let recomputedDigest;
  try {
    recomputedDigest = checkpointDigest(obj.body);
  } catch {
    recomputedDigest = null;
  }
  if (recomputedDigest !== obj.digest) {
    fail(state, 'CHECKPOINTS', obj.body?.checkpointSeq, `checkpoint ${obj.body?.checkpointSeq}: digest does not match its own body`);
  }
  const previous = state.checkpoints[state.checkpoints.length - 1];
  if (previous) {
    if (obj.body?.checkpointSeq <= previous.body?.checkpointSeq) {
      fail(state, 'CHECKPOINTS', obj.body?.checkpointSeq, 'checkpointSeq is not strictly increasing');
    }
    if (obj.body?.prevCheckpointDigest !== previous.digest) {
      fail(state, 'CHECKPOINTS', obj.body?.checkpointSeq, 'prevCheckpointDigest does not match the previous checkpoint');
    }
  } else if (obj.body?.prevCheckpointDigest !== null) {
    fail(state, 'CHECKPOINTS', obj.body?.checkpointSeq, 'the first checkpoint in the bundle has a non-null prevCheckpointDigest');
  }
  const knownHashAtHead = state.hashBySeq.get(obj.body?.headSeq);
  if (knownHashAtHead !== undefined && knownHashAtHead !== obj.body?.headHash) {
    fail(state, 'CHECKPOINTS', obj.body?.checkpointSeq, `checkpoint ${obj.body?.checkpointSeq}: headHash does not match the event at seq ${obj.body?.headSeq}`);
  }
}

function finalizeFooterComparison(state) {
  if (state.pendingLedgerFor) {
    fail(state, 'LEDGER', state.pendingLedgerExpectedSeq, `event ${state.pendingLedgerFor} (llm.usage/llm.failed) was never followed by its ledger row`);
  }

  const footer = state.footer;
  const c = state.counts;
  if (!footer.counts || footer.counts.events !== c.events || footer.counts.ledger !== c.ledger || footer.counts.checkpoints !== c.checkpoints || footer.counts.tombstones !== c.tombstones || footer.counts.pricing !== c.pricing) {
    fail(state, 'FORMAT', null, `footer counts (${JSON.stringify(footer.counts)}) do not match the lines actually present (${JSON.stringify(c)})`);
  }
  if (typeof footer.contentSha256 !== 'string' || footer.contentSha256 !== state.contentSha256) {
    fail(state, 'FORMAT', null, 'footer contentSha256 does not match the recomputed digest of the preceding lines');
  }

  const recomputedTotals = state.totals.toJSON();
  if (!deepEqualNumberSafe(recomputedTotals, footer.totals)) {
    fail(state, 'TOTALS', null, 'recomputed footer totals do not match the bundle\'s own footer.totals');
  }

  // REDACTION: every tombstone line must be committed by its audit event, with the exact original hash and
  // content hash (the tombstone-aware walk rule from issue #109, applied here against the bundle's own content
  // rather than a live database).
  for (const tombstone of state.tombstonesBySeq.values()) {
    const auditEvent = tombstone.auditSeq === null ? undefined : state.auditEventPayloadsBySeq.get(tombstone.auditSeq);
    if (!auditEvent) {
      fail(state, 'REDACTION', tombstone.seq, `tombstone at seq ${tombstone.seq}: no committing audit event at seq ${tombstone.auditSeq} in this bundle`);
      continue;
    }
    const committed = Array.isArray(auditEvent.payload?.events) ? auditEvent.payload.events.find((e) => e.id === tombstone.eventId) : undefined;
    const storedHash = state.hashBySeq.get(tombstone.seq);
    if (!committed || committed.hash !== storedHash || committed.contentHash !== tombstone.contentHash) {
      fail(state, 'REDACTION', tombstone.seq, `tombstone at seq ${tombstone.seq}: not committed by its audit event`);
    }
  }

  if (state.opts.expectCheckpoint) {
    const { seq, headHash } = state.opts.expectCheckpoint;
    const matchesACheckpoint = state.checkpoints.some((cp) => cp.body?.headSeq === seq && cp.body?.headHash === headHash);
    const matchesChain = state.hashBySeq.get(seq) === headHash;
    if (!matchesACheckpoint && !matchesChain) {
      fail(state, 'EXPECT', seq, `--expect-checkpoint ${seq}:${headHash} was not found among this bundle's checkpoints or chain`);
    }
  }
}

// -------------------------------------------------------------
// Streaming entry point
// -------------------------------------------------------------

/** Detects gzip by magic bytes (0x1f 0x8b), not only the `.gz` extension, per issue #110: "the verifier detects
 * gzip by magic bytes". Reads at most the first 2 bytes via a short-lived file descriptor, separate from the
 * streaming read that follows. */
function isGzipFile(filePath) {
  let fd;
  try {
    fd = openSync(filePath, 'r');
  } catch (error) {
    throw new InvalidBundleError(`could not open ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const buffer = Buffer.alloc(2);
    const bytesRead = readSync(fd, buffer, 0, 2, 0);
    return bytesRead >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
  } finally {
    closeSync(fd);
  }
}

/** Reads `filePath` (gzip auto-detected) and runs every check. Resolves to `{ verdict, checks, warnings,
 * firstFailure, range, keys, complete }`; never rejects for a tampered/malformed bundle (that is `verdict:
 * 'invalid'`), only for a genuine I/O failure. */
async function verifyBundle(filePath, options = {}) {
  const state = createVerifierState({
    trustedKeyFingerprint: options.trustedKeyFingerprint ?? null,
    expectCheckpoint: options.expectCheckpoint ?? null,
  });

  const gz = isGzipFile(filePath);
  let stream;
  try {
    stream = createReadStream(filePath, { highWaterMark: 1 << 20 });
  } catch (error) {
    throw new InvalidBundleError(`could not open ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const source = gz ? stream.pipe(createGunzip()) : stream;
  const rl = createInterface({ input: source, crlfDelay: Infinity });

  let sawAnyLine = false;
  try {
    for await (const rawLine of rl) {
      if (rawLine.length === 0) continue;
      sawAnyLine = true;
      let obj;
      try {
        obj = JSON.parse(rawLine);
      } catch {
        throw new InvalidBundleError(`line ${state.lineIndex + 1} is not valid JSON`);
      }
      // contentSha256 covers every line up to (and including the newline after) the line before the *first*
      // footer line, exactly as the writer computes it. Once that digest is finalized, nothing after it (a
      // second footer, or junk appended past the real one) is ever hashed again: a finalized Hash throws on a
      // further `update()`, and more importantly, those lines are never part of the digest by definition.
      const isFooter = obj && typeof obj === 'object' && obj.kind === 'footer';
      if (state.contentSha256 === undefined) {
        if (isFooter) {
          state.contentSha256 = state.hashStream.digest('hex');
        } else {
          state.hashStream.update(rawLine, 'utf8');
          state.hashStream.update('\n', 'utf8');
        }
      }
      processLine(state, obj, Buffer.byteLength(rawLine, 'utf8'));
    }
  } catch (error) {
    if (error instanceof InvalidBundleError) {
      return { verdict: 'invalid', message: error.message, checks: [], warnings: [], firstFailure: null, range: null, keys: [], complete: null };
    }
    throw error;
  }

  if (!sawAnyLine || state.header === null) {
    return { verdict: 'invalid', message: 'empty file or no header line', checks: [], warnings: [], firstFailure: null, range: null, keys: [], complete: null };
  }
  if (!state.footerSeen) {
    return { verdict: 'invalid', message: 'no footer line (truncated or broken download)', checks: [], warnings: [], firstFailure: null, range: null, keys: [], complete: null };
  }

  const warnings = [];
  if (state.header.complete === false) warnings.push('continuity before fromSeq not verified (partial range)');
  if (state.keysByKeyId.size === 0) warnings.push('no signing key in this bundle: checkpoints, if any, cannot be verified');
  const keyReports = [...state.keysByKeyId.values()].map((key) => {
    let fingerprint = null;
    try {
      fingerprint = keyFingerprintFromPem(key.publicKeyPem);
    } catch {
      // Already recorded as a KEY failure above.
    }
    return { keyId: key.keyId, fingerprint, pinned: options.trustedKeyFingerprint ? fingerprint === options.trustedKeyFingerprint : false };
  });

  const anyFailed = Object.values(state.checks).some((c) => !c.ok);
  const incomplete = state.header.complete === false;
  let verdict;
  if (anyFailed || (incomplete && options.requireComplete)) {
    verdict = 'fail';
  } else if (!options.trustedKeyFingerprint && keyReports.length > 0) {
    verdict = 'unpinned';
  } else if (options.trustedKeyFingerprint && keyReports.some((k) => !k.pinned)) {
    verdict = 'fail';
  } else {
    verdict = 'pass';
  }

  return {
    verdict,
    checks: Object.values(state.checks),
    warnings,
    firstFailure: state.firstFailure,
    range: state.header.range,
    keys: keyReports,
    complete: state.header.complete,
  };
}

// -------------------------------------------------------------
// CLI
// -------------------------------------------------------------

/** A literal `ed25519:<64-hex-char>` fingerprint (this codebase's existing `keyId` format, from
 * `server/audit/checkpointFormat.ts`'s `keyIdFor`) is pinned directly; anything else is a path to a PEM file
 * holding an SPKI Ed25519 public key, whose fingerprint is derived the same way `keyFingerprintFromPem` derives
 * it for a bundle's own `key` lines, matching #110's own "fingerprint string or a PEM file" wording for
 * `--trusted-key`. */
function parsePemOrFingerprint(value) {
  if (/^ed25519:[0-9a-f]{64}$/.test(value)) return value;
  const pem = readFileSync(value, 'utf8');
  return keyFingerprintFromPem(pem);
}

function parseExpectCheckpoint(value) {
  const match = /^(\d+):([0-9a-f]{64})$/.exec(value);
  if (!match) throw new CliUsageError(`--expect-checkpoint must be "<seq>:<64-hex-char-hash>", got ${JSON.stringify(value)}`);
  return { seq: Number(match[1]), headHash: match[2] };
}

class CliUsageError extends Error {}

function parseArgs(argv) {
  const args = { file: null, trustedKey: null, expectCheckpoint: null, requireComplete: false, json: false };
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--trusted-key') args.trustedKey = argv[++i];
    else if (arg === '--expect-checkpoint') args.expectCheckpoint = argv[++i];
    else if (arg === '--require-complete') args.requireComplete = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg.startsWith('--')) throw new CliUsageError(`unknown option ${arg}`);
    else positionals.push(arg);
  }
  if (!args.help) {
    if (positionals.length !== 1) throw new CliUsageError('expected exactly one bundle file argument');
    args.file = positionals[0];
  }
  return args;
}

const USAGE = `Usage: node verify-audit-bundle.mjs <bundle.avbundle.jsonl[.gz]>
  [--trusted-key <sha256:fingerprint | pem-file>]
  [--expect-checkpoint <seq>:<headHash>]
  [--require-complete] [--json]

Exit codes: 0 pass, 1 fail, 2 invalid, 3 unpinned.`;

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (error instanceof CliUsageError) {
      console.error(error.message);
      console.error(USAGE);
      return 2;
    }
    throw error;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  let trustedKeyFingerprint = null;
  let expectCheckpoint = null;
  try {
    if (args.trustedKey) trustedKeyFingerprint = await parsePemOrFingerprint(args.trustedKey);
    if (args.expectCheckpoint) expectCheckpoint = parseExpectCheckpoint(args.expectCheckpoint);
  } catch (error) {
    if (error instanceof CliUsageError) {
      console.error(error.message);
      return 2;
    }
    console.error(`could not read --trusted-key: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  let result;
  try {
    result = await verifyBundle(args.file, { trustedKeyFingerprint, expectCheckpoint, requireComplete: args.requireComplete });
  } catch (error) {
    if (error instanceof InvalidBundleError) {
      result = { verdict: 'invalid', message: error.message, checks: [], warnings: [], firstFailure: null, range: null, keys: [], complete: null };
    } else {
      console.error(`could not read ${args.file}: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
  }

  if (args.json) {
    console.log(
      JSON.stringify({
        verdict: result.verdict,
        complete: result.complete,
        range: result.range,
        keys: result.keys,
        warnings: result.warnings,
        checks: result.checks,
        firstFailure: result.firstFailure,
      })
    );
  } else {
    for (const check of result.checks) console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.id}${check.ok ? '' : `  ${check.detail}`}`);
    for (const warning of result.warnings) console.log(`WARN  ${warning}`);
    if (result.message) console.log(result.message);
    console.log(`verdict: ${result.verdict}`);
  }

  if (result.verdict === 'invalid') return 2;
  if (result.verdict === 'fail') return 1;
  if (result.verdict === 'unpinned') return 3;
  return 0;
}

const isMainModule = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      process.exit(2);
    }
  );
}

export {
  canonicalize,
  eventHash,
  checkpointSignedBytes,
  checkpointDigest,
  verifyCheckpointSignature,
  keyFingerprintFromPem,
  computeContentHash,
  resolvePrice,
  estimateCall,
  nanoToDecimalCost,
  verifyBundle,
  parseArgs,
  parseExpectCheckpoint,
  CliUsageError,
  InvalidBundleError,
};
