// Issue #70: the retention baseline. Covers the pure config parser (`parseRetentionConfig`) for the three
// `AGENT_VIEWER_RETENTION_*` variables, and the one-line startup warning text for an enabled ledger window.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRetentionConfig, usageRetentionWarning } from '../server/retention.ts';

function env(overrides = {}) {
  return {
    AGENT_VIEWER_RETENTION_DAYS: undefined,
    AGENT_VIEWER_USAGE_RETENTION_DAYS: undefined,
    AGENT_VIEWER_RETENTION_INTERVAL_MINUTES: undefined,
    ...overrides,
  };
}

test('parseRetentionConfig: unset, empty and whitespace-only all mean keep, with the default 60-minute interval', () => {
  for (const value of [undefined, '', '   ', '\t\n']) {
    const config = parseRetentionConfig(env({ AGENT_VIEWER_RETENTION_DAYS: value, AGENT_VIEWER_USAGE_RETENTION_DAYS: value }));
    assert.deepEqual(config, { eventsDays: null, ledgerDays: null, intervalMinutes: 60 });
  }
});

test('parseRetentionConfig: accepts the boundary values 1 and 36500 for a window, and 1 and 1440 for the interval', () => {
  assert.equal(parseRetentionConfig(env({ AGENT_VIEWER_RETENTION_DAYS: '1' })).eventsDays, 1);
  assert.equal(parseRetentionConfig(env({ AGENT_VIEWER_RETENTION_DAYS: '36500' })).eventsDays, 36500);
  assert.equal(parseRetentionConfig(env({ AGENT_VIEWER_USAGE_RETENTION_DAYS: '1' })).ledgerDays, 1);
  assert.equal(parseRetentionConfig(env({ AGENT_VIEWER_USAGE_RETENTION_DAYS: '36500' })).ledgerDays, 36500);
  assert.equal(parseRetentionConfig(env({ AGENT_VIEWER_RETENTION_INTERVAL_MINUTES: '1' })).intervalMinutes, 1);
  assert.equal(parseRetentionConfig(env({ AGENT_VIEWER_RETENTION_INTERVAL_MINUTES: '1440' })).intervalMinutes, 1440);
});

test('parseRetentionConfig: trims surrounding whitespace before validating a configured value', () => {
  assert.equal(parseRetentionConfig(env({ AGENT_VIEWER_RETENTION_DAYS: '  30  ' })).eventsDays, 30);
});

for (const bad of ['0', '-1', '1.5', '007', '1e3', 'abc', '36501', ' ']) {
  if (bad === ' ') continue; // whitespace-only is "keep", covered above.
  test(`parseRetentionConfig: rejects AGENT_VIEWER_RETENTION_DAYS=${JSON.stringify(bad)}`, () => {
    assert.throws(
      () => parseRetentionConfig(env({ AGENT_VIEWER_RETENTION_DAYS: bad })),
      /AGENT_VIEWER_RETENTION_DAYS must be an integer from 1 to 36500/
    );
  });
  test(`parseRetentionConfig: rejects AGENT_VIEWER_USAGE_RETENTION_DAYS=${JSON.stringify(bad)}`, () => {
    assert.throws(
      () => parseRetentionConfig(env({ AGENT_VIEWER_USAGE_RETENTION_DAYS: bad })),
      /AGENT_VIEWER_USAGE_RETENTION_DAYS must be an integer from 1 to 36500/
    );
  });
}

test('parseRetentionConfig: the error names the offending value', () => {
  assert.throws(
    () => parseRetentionConfig(env({ AGENT_VIEWER_RETENTION_DAYS: '0' })),
    /got "0"/
  );
});

for (const bad of ['0', '-1', '1.5', 'abc', '1441']) {
  test(`parseRetentionConfig: rejects AGENT_VIEWER_RETENTION_INTERVAL_MINUTES=${JSON.stringify(bad)}`, () => {
    assert.throws(
      () => parseRetentionConfig(env({ AGENT_VIEWER_RETENTION_INTERVAL_MINUTES: bad })),
      /AGENT_VIEWER_RETENTION_INTERVAL_MINUTES must be an integer from 1 to 1440/
    );
  });
}

test('parseRetentionConfig: the two windows are independent of each other', () => {
  const config = parseRetentionConfig(env({ AGENT_VIEWER_RETENTION_DAYS: '30' }));
  assert.equal(config.eventsDays, 30);
  assert.equal(config.ledgerDays, null, 'AGENT_VIEWER_USAGE_RETENTION_DAYS defaults to keep forever');
});

test('usageRetentionWarning: exact startup warning text for an enabled ledger window', () => {
  assert.equal(
    usageRetentionWarning(90),
    '[agent-viewer] usage ledger retention is enabled (90 days): consumption rows older than that are deleted for good'
  );
});
