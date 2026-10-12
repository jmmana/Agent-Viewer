// Prometheus text exposition writer (issue #350): names, label escaping, number formatting and the registry.
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  createMetricsRegistry,
  escapeHelp,
  escapeLabelValue,
  formatMetricValue,
  metricsAuthDisabled,
  metricsEnabled,
  metricsRateLimitMax,
  sanitizeLabelName,
  sanitizeMetricName,
} = await import('../server/metrics.ts');

test('metric and label names: invalid characters become _, a leading digit is prefixed', () => {
  assert.equal(sanitizeMetricName('agent_viewer_sse_clients'), 'agent_viewer_sse_clients');
  assert.equal(sanitizeMetricName('a.b-c d:e'), 'a_b_c_d:e');
  assert.equal(sanitizeMetricName('9lives'), '_9lives');
  assert.equal(sanitizeLabelName('a:b'), 'a_b');
  assert.equal(sanitizeLabelName('1x'), '_1x');
  assert.equal(sanitizeLabelName('__reserved'), '_reserved');
});

test('label values escape backslash, double quote and line feed; HELP escapes backslash and line feed', () => {
  assert.equal(escapeLabelValue('a\\b"c\nd'), 'a\\\\b\\"c\\nd');
  assert.equal(escapeHelp('a\\b"c\nd'), 'a\\\\b"c\\nd');
});

test('values: integers, floats, NaN and infinities in Prometheus spelling', () => {
  assert.equal(formatMetricValue(1), '1');
  assert.equal(formatMetricValue(0.25), '0.25');
  assert.equal(formatMetricValue(-0), '0');
  assert.equal(formatMetricValue(1e21), '1e+21');
  assert.equal(formatMetricValue(NaN), 'NaN');
  assert.equal(formatMetricValue(Infinity), '+Inf');
  assert.equal(formatMetricValue(-Infinity), '-Inf');
});

test('registry renders HELP, TYPE and samples, skips undefined labels and a throwing collector', () => {
  const registry = createMetricsRegistry();
  registry.register({ name: 'x_info', help: 'Info\nline', type: 'gauge', collect: () => [{ labels: { v: '1"2', skip: undefined }, value: 1 }] });
  registry.register({ name: 'broken', help: 'Throws', type: 'gauge', collect: () => { throw new Error('boom'); } });
  registry.register({ name: 'y_total', help: 'Count', type: 'counter', collect: () => 3 });
  assert.equal(
    registry.render(),
    '# HELP x_info Info\\nline\n# TYPE x_info gauge\nx_info{v="1\\"2"} 1\n# HELP y_total Count\n# TYPE y_total counter\ny_total 3\n',
  );
  assert.throws(() => registry.register({ name: 'x_info', help: '', type: 'gauge', collect: () => 0 }), /already registered/);
});

test('configuration: opt-in values, auth off switch and rate limit default', () => {
  for (const on of ['1', 'true', 'YES', ' on ']) assert.equal(metricsEnabled({ AGENT_VIEWER_METRICS: on }), true, on);
  for (const off of [undefined, '', '0', 'false', 'off', 'maybe']) assert.equal(metricsEnabled({ AGENT_VIEWER_METRICS: off }), false, String(off));
  assert.equal(metricsAuthDisabled({ AGENT_VIEWER_METRICS_AUTH: 'off' }), true);
  assert.equal(metricsAuthDisabled({}), false);
  assert.equal(metricsRateLimitMax({}), 120);
  assert.equal(metricsRateLimitMax({ AGENT_VIEWER_METRICS_RATE_LIMIT: '7' }), 7);
  assert.equal(metricsRateLimitMax({ AGENT_VIEWER_METRICS_RATE_LIMIT: 'abc' }), 120);
});
