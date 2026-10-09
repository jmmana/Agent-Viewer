/**
 * Issue #62: loads the golden reconciliation fixture (`tests/fixtures/reconciliation/`) for every run in
 * `tests/reconciliation.test.mjs`. Kept outside the `tests/*.test.mjs` glob on purpose (see
 * `tests/fixtures/reconciliation/README.md`), so it is a plain helper module, never a test file itself.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { CanonicalEvent } from '../../src/integrations/canonicalContract';
import type { UsageSummary } from '../../server/usageAggregates';
import type { UsageTally } from '../../src/integrations/usageTally';
import type { OfficeUsage } from '../../src/lib/usage';

const FIXTURE_DIR = path.join(import.meta.dirname, '..', 'fixtures', 'reconciliation');

function readJsonl(file: string): CanonicalEvent[] {
  const content = fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8');
  return content
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as CanonicalEvent);
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8')) as T;
}

/** Outcome vocabulary asserted against every store's `AppendResult` (issue #62's reduced scope: no webhook or
 * PATCH route, see the fixture README). */
export type GoldenOutcome = 'accepted' | 'duplicate' | 'conflict' | 'request-duplicate';

export interface GoldenExpected {
  ingestion: Record<string, GoldenOutcome>;
  server: {
    checkpointAfterLine6: UsageSummary;
    final: UsageSummary;
  };
  portal: {
    total: UsageTally;
    byAgent: Record<string, UsageTally>;
  };
  library: OfficeUsage;
}

export interface GoldenFixture {
  /** The 11 fixture lines, in file order (not sorted by timestamp): duplicates and conflicts must be appended
   * strictly after the original they repeat. */
  events: CanonicalEvent[];
  /** The canonical event the webhook delivery decodes to, appended directly by the store-level runs (issue #62
   * does not spin up the HTTP webhook route, see the fixture README). */
  webhookCanonical: CanonicalEvent;
  /** The events a host actually sees after every duplicate, conflict and failure is resolved: lines 1-6, the
   * webhook event, then line 10. Input for the portal and library runs. */
  accepted: CanonicalEvent[];
  expected: GoldenExpected;
}

export function loadGolden(): GoldenFixture {
  return {
    events: readJsonl('golden.events.jsonl'),
    webhookCanonical: readJson<CanonicalEvent>('golden.webhook-canonical.json'),
    accepted: readJsonl('golden.accepted.jsonl'),
    expected: readJson<GoldenExpected>('golden.expected.json'),
  };
}
