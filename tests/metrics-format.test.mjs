import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInProcessFamilies, METRICS_CONTENT_TYPE, renderExposition, sanitizeLabelValue } from '../server/metrics.ts';

// Issue #103 (first sub-issue): unit tests for the registry/writer in server/metrics.ts, independent of the HTTP
// route (tests/metrics-endpoint.test.mjs covers that).

test('metrics format: HELP/TYPE lines, one series per sample, in family order', () => {
  const body = renderExposition([
    { name: 'agent_viewer_build_info', help: 'Server version and storage mode.', type: 'gauge', samples: [{ labels: { version: '1.2.3', storage: 'memory' }, value: 1 }] },
    { name: 'agent_viewer_sse_clients', help: 'Open SSE connections.', type: 'gauge', samples: [{ labels: {}, value: 2 }] },
  ]);
  const lines = body.split('\n').filter((l) => l.length > 0);
  assert.deepEqual(lines, [
    '# HELP agent_viewer_build_info Server version and storage mode.',
    '# TYPE agent_viewer_build_info gauge',
    'agent_viewer_build_info{version="1.2.3",storage="memory"} 1',
    '# HELP agent_viewer_sse_clients Open SSE connections.',
    '# TYPE agent_viewer_sse_clients gauge',
    'agent_viewer_sse_clients 2',
  ]);
  assert.ok(body.endsWith('\n'), 'ends with a trailing newline');
});

test('metrics format: a family with zero samples still gets its HELP/TYPE lines', () => {
  const body = renderExposition([{ name: 'agent_viewer_tokens_total', help: 'h', type: 'counter', samples: [] }]);
  assert.equal(body, '# HELP agent_viewer_tokens_total h\n# TYPE agent_viewer_tokens_total counter\n');
});

test('metrics format: no families renders the empty string', () => {
  assert.equal(renderExposition([]), '');
});

test('metrics format: label values are escaped (backslash, quote, newline, in that order)', () => {
  const body = renderExposition([{ name: 'm', help: 'h', type: 'gauge', samples: [{ labels: { model: 'a"b\\c\nd' }, value: 1 }] }]);
  assert.match(body, /m\{model="a\\"b\\\\c\\nd"\} 1/);
});

test('metrics format: sanitizeLabelValue strips control characters and caps at 100 chars', () => {
  assert.equal(sanitizeLabelValue('a\x00b\x1fc\x7fd'), 'abcd');
  const long = 'x'.repeat(150);
  const sanitized = sanitizeLabelValue(long);
  assert.equal(sanitized.length, 100);
  assert.equal(sanitized, 'x'.repeat(100));
});

test('metrics format: two values that collapse to the same sanitized label would be the caller\'s job to merge, but sanitize is itself deterministic', () => {
  assert.equal(sanitizeLabelValue('model\x00'), sanitizeLabelValue('model'));
});

test('metrics format: number formatting is a plain decimal, trailing zeros trimmed, no exponent', () => {
  const body = renderExposition([
    { name: 'm', help: 'h', type: 'counter', samples: [{ labels: {}, value: 18.4021 }] },
  ]);
  assert.match(body, /m 18\.4021/);
  const intBody = renderExposition([{ name: 'm', help: 'h', type: 'counter', samples: [{ labels: {}, value: 5 }] }]);
  assert.match(intBody, /m 5\n/);
  const trimBody = renderExposition([{ name: 'm', help: 'h', type: 'counter', samples: [{ labels: {}, value: 1.5 }] }]);
  assert.match(trimBody, /m 1\.5\n/);
});

test('metrics format: Content-Type is the Prometheus text exposition format 0.0.4', () => {
  assert.equal(METRICS_CONTENT_TYPE, 'text/plain; version=0.0.4; charset=utf-8');
});

test('metrics format: buildInProcessFamilies shapes build_info (gauge, always 1) and sse_clients', () => {
  const families = buildInProcessFamilies({ version: '0.7.0', storage: 'sqlite', sseClients: 3 });
  const buildInfo = families.find((f) => f.name === 'agent_viewer_build_info');
  const sseClients = families.find((f) => f.name === 'agent_viewer_sse_clients');
  assert.equal(buildInfo.type, 'gauge');
  assert.deepEqual(buildInfo.samples, [{ labels: { version: '0.7.0', storage: 'sqlite' }, value: 1 }]);
  assert.equal(sseClients.type, 'gauge');
  assert.deepEqual(sseClients.samples, [{ labels: {}, value: 3 }]);
});

test('metrics format: buildInProcessFamilies sanitizes the version label', () => {
  const families = buildInProcessFamilies({ version: 'v1\x00evil', storage: 'memory', sseClients: 0 });
  const buildInfo = families.find((f) => f.name === 'agent_viewer_build_info');
  assert.equal(buildInfo.samples[0].labels.version, 'v1evil');
});
