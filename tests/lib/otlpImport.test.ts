/**
 * Issue #74: the library-level part of OTLP file import. `tests/event-log-parser.test.mjs` (node:test) covers
 * the parser itself; this file covers what the rest of `src/lib` does with its output: `summarizeUsage` on
 * real converted events, and the pure `getDropErrorKey` helper the demo app uses to pick a localized message.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseEventLog, summarizeUsage } from '../../src/lib/index';
import { getDropErrorKey } from '../../src/integrations/dropErrorKey';

const fixturesDir = path.join(import.meta.dirname, '../fixtures/otlp');
function readFixture(name: string): string {
  return fs.readFileSync(path.join(fixturesDir, name), 'utf8');
}

describe('parseEventLog + summarizeUsage: OTLP logs import', () => {
  it('sums the token totals from a converted OTLP logs file', async () => {
    const result = await parseEventLog(readFixture('claude-code-logs.pretty.json'));
    const usage = summarizeUsage(result.events);

    // Three llm.usage events (inputTokens 49837, 49837, 2; outputTokens 4 each); the llm.failed event is not
    // counted by summarizeUsage at all (it never reports usage figures).
    expect(usage.total?.inputTokens).toBe(49837 + 49837 + 2);
    expect(usage.total?.outputTokens).toBe(4 + 4 + 4);
  });

  it('reports the summary cost as null, not 0, once any counted event has no reported cost', async () => {
    const result = await parseEventLog(readFixture('claude-code-logs.pretty.json'));
    const usage = summarizeUsage(result.events);
    expect(usage.total?.cost).toBeNull();
  });
});

describe('getDropErrorKey', () => {
  it('returns the empty string once the drop produced events, regardless of issues', () => {
    expect(getDropErrorKey({ events: [{} as never], issues: [] })).toBe('');
  });

  it('picks drop.otlpMetrics for a metrics-not-replayable issue', () => {
    expect(
      getDropErrorKey({ events: [], issues: [{ line: 1, error: '', code: 'otlp-metrics-not-replayable' }] }),
    ).toBe('drop.otlpMetrics');
  });

  it('picks drop.otlpTraces for a traces-not-supported issue', () => {
    expect(
      getDropErrorKey({ events: [], issues: [{ line: 1, error: '', code: 'otlp-traces-not-supported' }] }),
    ).toBe('drop.otlpTraces');
  });

  it('picks drop.otlpNoUsage for a no-usage-records issue', () => {
    expect(
      getDropErrorKey({ events: [], issues: [{ line: 1, error: '', code: 'otlp-no-usage-records' }] }),
    ).toBe('drop.otlpNoUsage');
  });

  it('picks drop.otlpRejected for a record-skipped issue', () => {
    expect(
      getDropErrorKey({ events: [], issues: [{ line: 1, error: '', code: 'otlp-record-skipped' }] }),
    ).toBe('drop.otlpRejected');
  });

  it('falls back to drop.noEvents for an uncoded issue or no issue at all', () => {
    expect(getDropErrorKey({ events: [], issues: [{ line: 1, error: 'Contract validation failed' }] })).toBe(
      'drop.noEvents',
    );
    expect(getDropErrorKey({ events: [], issues: [] })).toBe('drop.noEvents');
  });

  it('ranks metrics above traces above no-usage above record-skipped when a file has several', () => {
    const issues = [
      { line: 1, error: '', code: 'otlp-record-skipped' as const },
      { line: 2, error: '', code: 'otlp-traces-not-supported' as const },
      { line: 3, error: '', code: 'otlp-metrics-not-replayable' as const },
    ];
    expect(getDropErrorKey({ events: [], issues })).toBe('drop.otlpMetrics');
  });
});
