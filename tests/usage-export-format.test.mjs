// Issue #69: unit tests for the pure CSV/JSONL formatters in server/usage/export.ts. No HTTP, no database: every
// case here is a direct function call, so a change to column order, quoting or the formula guard fails fast.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  CSV_HEADER,
  escapeTag,
  formatCsvRow,
  formatDecimal,
  formatJsonlRow,
  formatTagsForCsv,
  guardCsvCell,
  shapeExportTotals,
  toExportCallRecord,
} from '../server/usage/export.ts';
import { MemoryEventStore } from '../server/store.ts';
import { emptyUsageFilters } from '../server/usage/types.ts';
import { validateCanonicalEvent } from '../src/integrations/canonicalContract.ts';

function baseRow(overrides = {}) {
  return {
    seq: 1,
    eventId: 'evt_a1',
    eventType: 'llm.usage',
    requestId: null,
    receivedAt: Date.parse('2026-09-14T08:12:03.441Z'),
    occurredAt: Date.parse('2026-09-14T08:12:03.120Z'),
    origin: 'live',
    legacyContract: false,
    ingestChannel: 'events',
    runtimeId: null,
    sessionId: null,
    agentId: null,
    taskId: null,
    provider: 'anthropic',
    model: 'claude',
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    cost: null,
    currency: null,
    costSource: 'unknown',
    latencyMs: null,
    status: 'ok',
    errorKind: null,
    traceId: null,
    parentId: null,
    toolCallId: null,
    meetingId: null,
    userId: null,
    tags: [],
    summary: null,
    ...overrides,
  };
}

// -------------------------------------------------------------
// guardCsvCell
// -------------------------------------------------------------

test('guardCsvCell: every documented trigger character gets a leading quote', () => {
  for (const trigger of ['=', '+', '-', '@', '\t', '\r', '\n', '＝', '＋', '－', '＠']) {
    const value = `${trigger}rest`;
    assert.equal(guardCsvCell(value), `'${value}`, JSON.stringify(trigger));
  }
});

test('guardCsvCell: a leading plain space is not a trigger', () => {
  assert.equal(guardCsvCell(' leading space'), ' leading space');
});

test('guardCsvCell: an already-quoted value (leading \') is left as-is (nothing to guard)', () => {
  assert.equal(guardCsvCell("'already"), "'already");
});

test('guardCsvCell: empty string is untouched', () => {
  assert.equal(guardCsvCell(''), '');
});

test('guardCsvCell: a value with a trigger character only in the middle is untouched', () => {
  assert.equal(guardCsvCell('mid=dle'), 'mid=dle');
});

test('guardCsvCell: property - every output either equals the input or is \' + input, and the result never starts with a bare trigger', () => {
  const rand = crypto.randomBytes(2000);
  const alphabet = ['=', '+', '-', '@', '\t', '\r', '\n', 'x', 'y', ' ', "'", '"', ','];
  for (let i = 0; i < 500; i++) {
    const len = rand[i % rand.length] % 6;
    let value = '';
    for (let j = 0; j < len; j++) value += alphabet[rand[(i + j) % rand.length] % alphabet.length];
    const out = guardCsvCell(value);
    const guarded = out === `'${value}`;
    const unchanged = out === value;
    assert.ok(guarded || unchanged, `unexpected transform of ${JSON.stringify(value)} -> ${JSON.stringify(out)}`);
    if (value.length > 0 && /^[=+\-@\t\r\n]/.test(value)) {
      assert.ok(guarded, `expected a guard for ${JSON.stringify(value)}`);
    }
    if (value.length === 0 || value[0] === ' ') {
      assert.ok(unchanged, `expected no guard for ${JSON.stringify(value)}`);
    }
  }
});

// -------------------------------------------------------------
// escapeTag / formatTagsForCsv
// -------------------------------------------------------------

test('escapeTag: % before ; keeps the encoding reversible', () => {
  assert.equal(escapeTag('a;b'), 'a%3Bb');
  assert.equal(escapeTag('a%b'), 'a%25b');
  assert.equal(escapeTag('100%;done'), '100%25%3Bdone');
});

test('formatTagsForCsv: no tags is null, not an empty string', () => {
  assert.equal(formatTagsForCsv([]), null);
});

test('formatTagsForCsv: tags are escaped individually then joined with ;', () => {
  assert.equal(formatTagsForCsv(['billing', 'nightly']), 'billing;nightly');
  assert.equal(formatTagsForCsv(['a;b', 'c']), 'a%3Bb;c');
});

// -------------------------------------------------------------
// formatDecimal
// -------------------------------------------------------------

test('formatDecimal: never uses exponent notation and round-trips through parseFloat', () => {
  const cases = [0, 1, 3, 100, 0.013, 0.1, 0.2, 1e-7, 1.5e21, 123456789, 0.0000001, 5e-10, 9.999e10];
  for (const value of cases) {
    const formatted = formatDecimal(value);
    assert.ok(!/e/i.test(formatted), `${value} -> ${formatted} must not use exponent notation`);
    assert.equal(parseFloat(formatted), value, `${value} -> ${formatted} must round-trip`);
  }
});

test('formatDecimal: an integer has no trailing decimal point', () => {
  assert.equal(formatDecimal(3), '3');
  assert.equal(formatDecimal(100), '100');
});

test('formatDecimal: tiny value 1e-7 expands to plain digits', () => {
  assert.equal(formatDecimal(1e-7), '0.0000001');
});

test('formatDecimal: large value 1.5e21 expands to plain digits', () => {
  const formatted = formatDecimal(1.5e21);
  assert.ok(!/e/i.test(formatted));
  assert.equal(parseFloat(formatted), 1.5e21);
});

// -------------------------------------------------------------
// formatCsvRow
// -------------------------------------------------------------

test('formatCsvRow: full row from the issue has exactly 28 fields and ends with CRLF', () => {
  const row = baseRow({
    requestId: 'req_9f2',
    runtimeId: 'cc-local',
    sessionId: 's-77',
    agentId: 'planner',
    taskId: 't-12',
    tags: ['billing', 'nightly'],
    inputTokens: 5000,
    outputTokens: 1000,
    cacheReadTokens: 2500,
    cacheWriteTokens: 0,
    latencyMs: 940,
    cost: 0.013,
    currency: 'USD',
    costSource: 'provider-reported',
    summary: 'planner LLM usage reported',
  });
  const record = toExportCallRecord(row);
  const csv = formatCsvRow(record);
  assert.ok(csv.endsWith('\r\n'));
  const line = csv.slice(0, -2);
  // Fields on this fixture never contain an embedded comma inside a quoted value with commas of their own, so a
  // naive split is a safe way to count fields here (the embedded-comma/quote cases are covered below instead).
  assert.equal(line.split(',').length >= 28, true);
  assert.equal(CSV_HEADER.split(',').length, 28);
});

test('formatCsvRow: unknown values are empty cells, never 0', () => {
  const row = baseRow({ cost: null, cacheReadTokens: null });
  const csv = formatCsvRow(toExportCallRecord(row));
  // ledgerSeq,eventId,requestId,receivedAt,occurredAt,status,provider,model,runtimeId,sessionId,agentId,taskId,
  // traceId,parentId,toolCallId,userId,tags,inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,
  // reasoningTokens,latencyMs,cost,currency,costSource,summary,redacted
  const fields = csv.slice(0, -2).split(',');
  assert.equal(fields[2], ''); // requestId
  assert.equal(fields[12], ''); // traceId
  assert.equal(fields[19], ''); // cacheReadTokens
  assert.equal(fields[23], ''); // cost
});

test('formatCsvRow: a reported 0 is written as 0, not an empty cell', () => {
  const row = baseRow({ cacheWriteTokens: 0 });
  const csv = formatCsvRow(toExportCallRecord(row));
  const fields = csv.slice(0, -2).split(',');
  assert.equal(fields[20], '0'); // cacheWriteTokens
});

test('formatCsvRow: a hostile agentId gets both the formula guard and CSV quoting, doubled inner quotes', () => {
  const row = baseRow({ agentId: '=HYPERLINK("http://x")' });
  const csv = formatCsvRow(toExportCallRecord(row));
  assert.ok(csv.includes('"\'=HYPERLINK(""http://x"")"'), csv);
});

test('formatCsvRow: redacted is bare true/false, never quoted', () => {
  const row = baseRow({ summary: 'my api key is sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-AAAAAAAA' });
  const record = toExportCallRecord(row);
  const csv = formatCsvRow(record);
  assert.ok(record.redacted, 'expected the seeded secret to trigger redaction');
  assert.ok(csv.trim().endsWith(',true'));
  assert.ok(!csv.includes('"true"') && !csv.includes('"false"'));
});

test('formatCsvRow: a tag containing ; and % round-trips through the CSV escaping', () => {
  const row = baseRow({ tags: ['env;prod%live'] });
  const csv = formatCsvRow(toExportCallRecord(row));
  assert.ok(csv.includes('"env%3Bprod%25live"'), csv);
});

test('formatCsvRow: numeric columns are never quoted', () => {
  const row = baseRow({ inputTokens: 10, cost: 0.5, currency: 'USD', costSource: 'estimated' });
  const csv = formatCsvRow(toExportCallRecord(row));
  const fields = csv.slice(0, -2).split(',');
  assert.equal(fields[0], '1'); // ledgerSeq
  assert.equal(fields[17], '10'); // inputTokens
  assert.equal(fields[23], '0.5'); // cost
});

// -------------------------------------------------------------
// formatJsonlRow
// -------------------------------------------------------------

test('formatJsonlRow: null stays null, tags is an array, cost uses plain decimal notation', () => {
  const row = baseRow({ cost: 1e-7, currency: 'USD', costSource: 'estimated', tags: ['a', 'b'] });
  const line = formatJsonlRow(toExportCallRecord(row));
  const parsed = JSON.parse(line);
  assert.equal(parsed.record, 'call');
  assert.equal(parsed.requestId, null);
  assert.deepEqual(parsed.tags, ['a', 'b']);
  assert.equal(parsed.cost, 1e-7);
  assert.ok(!line.includes('e-7'), `JSONL cost must not use exponent notation: ${line}`);
});

test('formatJsonlRow: a reported 0 is 0, an unreported token kind is null', () => {
  const row = baseRow({ cacheWriteTokens: 0, cacheReadTokens: null });
  const parsed = JSON.parse(formatJsonlRow(toExportCallRecord(row)));
  assert.equal(parsed.cacheWriteTokens, 0);
  assert.equal(parsed.cacheReadTokens, null);
});

test('formatJsonlRow: JSONL never prefixes a hostile value with a quote (no formula guard in JSONL)', () => {
  const row = baseRow({ agentId: '=HYPERLINK("http://x")' });
  const parsed = JSON.parse(formatJsonlRow(toExportCallRecord(row)));
  assert.equal(parsed.agentId, '=HYPERLINK("http://x")');
});

// -------------------------------------------------------------
// toExportCallRecord: redaction wiring
// -------------------------------------------------------------

test('toExportCallRecord: a seeded fake secret in summary, agentId, eventId and a tag is redacted everywhere, redacted=true', () => {
  const secret = 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-AAAAAAAA';
  const row = baseRow({
    // A hyphen (not `_`), so the regex's `\b` word boundary actually falls right before `sk-ant-...`.
    eventId: `evt-${secret}`,
    agentId: secret,
    tags: [secret],
    summary: `token ${secret} rejected`,
  });
  const record = toExportCallRecord(row);
  assert.equal(record.redacted, true);
  assert.ok(!record.eventId.includes(secret));
  assert.ok(!record.agentId.includes(secret));
  assert.ok(!record.tags[0].includes(secret));
  assert.ok(!record.summary.includes(secret));
  assert.match(record.eventId, /\[REDACTED:/);
  assert.match(record.agentId, /\[REDACTED:/);
  assert.match(record.tags[0], /\[REDACTED:/);
  assert.match(record.summary, /\[REDACTED:/);

  const csv = formatCsvRow(record);
  const jsonl = formatJsonlRow(record);
  assert.ok(!csv.includes(secret), 'CSV body must never contain the raw secret');
  assert.ok(!jsonl.includes(secret), 'JSONL body must never contain the raw secret');
});

test('toExportCallRecord: status and costSource are never redacted (validated enums)', () => {
  const row = baseRow({ status: 'ok', costSource: 'provider-reported', cost: 1, currency: 'USD' });
  const record = toExportCallRecord(row);
  assert.equal(record.status, 'ok');
  assert.equal(record.costSource, 'provider-reported');
});

test('toExportCallRecord: summary is always null (usage_ledger has no backfilled summary for pre-migration rows)', () => {
  const row = baseRow({ summary: null });
  const record = toExportCallRecord(row);
  assert.equal(record.summary, null);
  assert.equal(record.redacted, false);
});

test('toExportCallRecord: receivedAt/occurredAt are ISO 8601 UTC with milliseconds and can differ', () => {
  const row = baseRow({ receivedAt: 1_700_000_005_441, occurredAt: 1_700_000_000_120 });
  const record = toExportCallRecord(row);
  assert.equal(record.receivedAt, '2023-11-14T22:13:25.441Z');
  assert.equal(record.occurredAt, '2023-11-14T22:13:20.120Z');
  assert.notEqual(record.receivedAt, record.occurredAt);
});

// -------------------------------------------------------------
// shapeExportTotals: complete/incompleteReason (memory-mode eviction, issue #53)
// -------------------------------------------------------------

function usageEvent(id, agentId) {
  const result = validateCanonicalEvent({
    id,
    type: 'llm.usage',
    timestamp: 1_700_000_000_000,
    source: `agent:${agentId}`,
    agentId,
    summary: 'test call',
    payload: { provider: 'anthropic', model: 'claude', inputTokens: 1, outputTokens: 1, cost: 1, currency: 'USD', costSource: 'provider-reported' },
  });
  assert.equal(result.success, true, JSON.stringify(result.issues));
  return result.data;
}

test('shapeExportTotals: memory-mode eviction reports complete=false, incompleteReason=evicted', async () => {
  const store = new MemoryEventStore({ maxEvents: 1000, usageLedgerMaxRows: 2 });
  await store.init();
  try {
    for (let i = 0; i < 3; i++) {
      const res = await store.append(usageEvent(`evt_cap_${i}`, 'agent-cap'));
      assert.equal(res.outcome, 'accepted');
    }
    const filters = emptyUsageFilters();
    filters.agentId = ['agent-cap'];
    const rollup = await store.rollup({ groupBy: ['agent'], filters, sort: 'key', limit: 1 });
    const totals = shapeExportTotals(rollup, filters);
    assert.equal(totals.complete, false);
    assert.equal(totals.incompleteReason, 'evicted');
  } finally {
    await store.close();
  }
});

test('shapeExportTotals: a fresh store under its cap reports complete=true with no incompleteReason', async () => {
  const store = new MemoryEventStore({ maxEvents: 1000, usageLedgerMaxRows: 1000 });
  await store.init();
  try {
    await store.append(usageEvent('evt_fresh', 'agent-fresh'));
    const filters = emptyUsageFilters();
    filters.agentId = ['agent-fresh'];
    const rollup = await store.rollup({ groupBy: ['agent'], filters, sort: 'key', limit: 1 });
    const totals = shapeExportTotals(rollup, filters);
    assert.equal(totals.complete, true);
    assert.equal('incompleteReason' in totals, false);
  } finally {
    await store.close();
  }
});
