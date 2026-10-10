// Issue #67 (section 2): `parseUsageFilters`, shared with the rollup endpoint (#66). Covers every
// acceptance-criteria row: the valid shapes, the full 400 table, and the calls-only gating. Issue #66 extended
// `UsageFilters` with its own rollup-only fields (`userId`, `tag`, `asOfSeq`, `utcOffsetMinutes`), gated by
// `allowRollupOnly` the same way these calls-only fields are gated by `allowCallsOnly`; the default-shape
// assertion below includes them (always present, empty/null unless `allowRollupOnly` is set) so this file stays
// the single source of truth for the shared contract's exact shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUsageFilters } from '../server/usage/filters.ts';

function okFilters(query, options = { allowCallsOnly: true }) {
  const result = parseUsageFilters(query, options);
  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.issues));
  return result.value;
}

function issuePaths(query, options = { allowCallsOnly: true }) {
  const result = parseUsageFilters(query, options);
  assert.equal(result.ok, false, 'expected the query to be rejected');
  return result.issues.map((issue) => issue.path);
}

test('parseUsageFilters: defaults with no query at all', () => {
  const value = okFilters({});
  assert.deepEqual(value.filters, {
    from: null,
    to: null,
    timeBasis: 'received',
    agentId: [],
    sessionId: [],
    runtimeId: [],
    taskId: [],
    provider: [],
    model: [],
    status: [],
    costSource: [],
    currency: [],
    requestId: [],
    traceId: null,
    userId: [],
    tag: [],
    asOfSeq: null,
    utcOffsetMinutes: 0,
  });
  assert.equal(value.order, 'desc');
  assert.equal(value.limit, 100);
  assert.equal(value.cursor, null);
});

test('parseUsageFilters: repeatable filters accept one value or several, OR within the key', () => {
  const single = okFilters({ agentId: 'researcher' });
  assert.deepEqual(single.filters.agentId, ['researcher']);

  const many = okFilters({ agentId: ['researcher', 'writer'], provider: 'anthropic' });
  assert.deepEqual(many.filters.agentId, ['researcher', 'writer']);
  assert.deepEqual(many.filters.provider, ['anthropic']);
});

test('parseUsageFilters: from/to as epoch milliseconds, half-open window', () => {
  const value = okFilters({ from: '1700000000000', to: '1700003600000' });
  assert.equal(value.filters.from, 1700000000000);
  assert.equal(value.filters.to, 1700003600000);
});

test('parseUsageFilters: from/to as ISO 8601 with an explicit offset', () => {
  const value = okFilters({ from: '2026-10-01T00:00:00Z', to: '2026-10-08T00:00:00+02:00' });
  assert.equal(value.filters.from, Date.parse('2026-10-01T00:00:00Z'));
  assert.equal(value.filters.to, Date.parse('2026-10-08T00:00:00+02:00'));
});

test('parseUsageFilters: timeBasis default and explicit values', () => {
  assert.equal(okFilters({}).filters.timeBasis, 'received');
  assert.equal(okFilters({ timeBasis: 'occurred' }).filters.timeBasis, 'occurred');
  assert.deepEqual(issuePaths({ timeBasis: 'bogus' }), ['timeBasis']);
});

test('parseUsageFilters: currency accepts ISO codes and the literal "none", combined', () => {
  const value = okFilters({ currency: ['USD', 'none'] });
  assert.deepEqual(value.filters.currency, ['USD', 'none']);
});

test('parseUsageFilters: calls-only parameters (requestId, traceId, order, limit, cursor)', () => {
  const value = okFilters({ requestId: ['req_1', 'req_2'], traceId: 'trace_1', order: 'asc', limit: '7', cursor: 'abc' });
  assert.deepEqual(value.filters.requestId, ['req_1', 'req_2']);
  assert.equal(value.filters.traceId, 'trace_1');
  assert.equal(value.order, 'asc');
  assert.equal(value.limit, 7);
  assert.equal(value.cursor, 'abc');
});

test('parseUsageFilters: calls-only parameters are rejected as unknown when allowCallsOnly is false', () => {
  for (const key of ['requestId', 'traceId', 'order', 'limit', 'cursor']) {
    assert.deepEqual(issuePaths({ [key]: 'x' }, { allowCallsOnly: false }), [key]);
  }
});

test('parseUsageFilters: rollup-only parameters (userId, tag, asOfSeq, utcOffsetMinutes), issue #66', () => {
  const value = okFilters(
    { userId: ['u1', 'u2'], tag: 'alpha', asOfSeq: '42', utcOffsetMinutes: '-300' },
    { allowCallsOnly: false, allowRollupOnly: true }
  );
  assert.deepEqual(value.filters.userId, ['u1', 'u2']);
  assert.deepEqual(value.filters.tag, ['alpha']);
  assert.equal(value.filters.asOfSeq, 42);
  assert.equal(value.filters.utcOffsetMinutes, -300);
});

test('parseUsageFilters: rollup-only parameters are rejected as unknown when allowRollupOnly is not set', () => {
  for (const key of ['userId', 'tag', 'asOfSeq', 'utcOffsetMinutes']) {
    assert.deepEqual(issuePaths({ [key]: 'x' }, { allowCallsOnly: true }), [key]);
    assert.deepEqual(issuePaths({ [key]: 'x' }, { allowCallsOnly: false }), [key]);
  }
});

test('parseUsageFilters: asOfSeq and utcOffsetMinutes validation', () => {
  const rollupOnly = { allowCallsOnly: false, allowRollupOnly: true };
  assert.deepEqual(issuePaths({ asOfSeq: '0' }, rollupOnly), ['asOfSeq']);
  assert.deepEqual(issuePaths({ asOfSeq: 'abc' }, rollupOnly), ['asOfSeq']);
  assert.deepEqual(issuePaths({ utcOffsetMinutes: '900' }, rollupOnly), ['utcOffsetMinutes']);
  assert.deepEqual(issuePaths({ utcOffsetMinutes: '-900' }, rollupOnly), ['utcOffsetMinutes']);
  assert.deepEqual(issuePaths({ utcOffsetMinutes: 'abc' }, rollupOnly), ['utcOffsetMinutes']);
  assert.equal(okFilters({ utcOffsetMinutes: '-720' }, rollupOnly).filters.utcOffsetMinutes, -720);
  assert.equal(okFilters({ utcOffsetMinutes: '840' }, rollupOnly).filters.utcOffsetMinutes, 840);
});

test('parseUsageFilters: token and api_key are accepted and ignored, never surfaced as filters', () => {
  const value = okFilters({ token: 'secret', api_key: 'secret2', agentId: 'researcher' });
  assert.deepEqual(value.filters.agentId, ['researcher']);
});

// ---------------------------------------------------------------
// The 400 table (issue #67's acceptance criteria)
// ---------------------------------------------------------------

test('parseUsageFilters: unknown parameter', () => {
  assert.deepEqual(issuePaths({ notAFilter: 'x' }), ['notAFilter']);
});

test('parseUsageFilters: wrong case is an unknown parameter ("agentid=")', () => {
  assert.deepEqual(issuePaths({ agentid: 'x' }), ['agentid']);
});

test('parseUsageFilters: empty value is rejected', () => {
  assert.deepEqual(issuePaths({ agentId: '' }), ['agentId']);
});

test('parseUsageFilters: an object shape ("agentId[x]=1") is rejected', () => {
  assert.deepEqual(issuePaths({ agentId: { x: '1' } }), ['agentId']);
});

test('parseUsageFilters: a non-repeatable parameter given twice is rejected ("limit=1&limit=2")', () => {
  assert.deepEqual(issuePaths({ limit: ['1', '2'] }), ['limit']);
});

test('parseUsageFilters: bad date', () => {
  assert.deepEqual(issuePaths({ from: 'not-a-date' }), ['from']);
});

test('parseUsageFilters: date without an offset is rejected', () => {
  assert.deepEqual(issuePaths({ from: '2026-10-01T00:00:00' }), ['from']);
});

test('parseUsageFilters: date-only value is rejected', () => {
  assert.deepEqual(issuePaths({ from: '2026-10-01' }), ['from']);
});

test('parseUsageFilters: from >= to is rejected', () => {
  assert.deepEqual(issuePaths({ from: '1700000000000', to: '1700000000000' }), ['to']);
  assert.deepEqual(issuePaths({ from: '1700000000001', to: '1700000000000' }), ['to']);
});

test('parseUsageFilters: bad enum values', () => {
  assert.deepEqual(issuePaths({ status: 'not_a_status' }), ['status']);
  assert.deepEqual(issuePaths({ costSource: 'bogus' }), ['costSource']);
  assert.deepEqual(issuePaths({ currency: 'us' }), ['currency']);
  assert.deepEqual(issuePaths({ order: 'sideways' }), ['order']);
});

test('parseUsageFilters: more than 100 values for one key', () => {
  const many = Array.from({ length: 101 }, (_, i) => `agent_${i}`);
  assert.deepEqual(issuePaths({ agentId: many }), ['agentId']);
  const exactly100 = Array.from({ length: 100 }, (_, i) => `agent_${i}`);
  assert.equal(okFilters({ agentId: exactly100 }).filters.agentId.length, 100);
});

test('parseUsageFilters: limit out of range, non-numeric, or zero', () => {
  assert.deepEqual(issuePaths({ limit: '0' }), ['limit']);
  assert.deepEqual(issuePaths({ limit: '1001' }), ['limit']);
  assert.deepEqual(issuePaths({ limit: 'abc' }), ['limit']);
  assert.equal(okFilters({ limit: '1' }).limit, 1);
  assert.equal(okFilters({ limit: '1000' }).limit, 1000);
});

test('parseUsageFilters: every valid status is accepted', () => {
  for (const status of ['ok', 'rate_limited', 'overloaded', 'timeout', 'invalid_request', 'auth', 'server_error', 'cancelled', 'network', 'unknown']) {
    assert.deepEqual(okFilters({ status }).filters.status, [status]);
  }
});

test('parseUsageFilters: collects multiple issues from one query', () => {
  const result = parseUsageFilters({ notAFilter: 'x', limit: 'abc', from: 'bad-date' }, { allowCallsOnly: true });
  assert.equal(result.ok, false);
  const paths = result.issues.map((i) => i.path).sort();
  assert.deepEqual(paths, ['from', 'limit', 'notAFilter']);
});
