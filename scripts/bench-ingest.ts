#!/usr/bin/env -S npx tsx
/**
 * Issue #105 acceptance criterion: sequential single-event `store.append` throughput on SQLite, 10,000 events,
 * at least 1,000 events/s on a developer laptop. Not part of the CI gate: run manually with
 * `npx tsx scripts/bench-ingest.ts` and record the result (events/s, machine) in the PR alongside the 0.2.1
 * baseline.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SQLiteEventStore } from '../server/store';
import type { CanonicalEvent } from '../src/integrations/canonicalContract';

const EVENT_COUNT = 10_000;

function buildEvent(index: number): CanonicalEvent {
  return {
    schemaVersion: '1.0',
    id: `evt_bench_${index}`,
    type: 'agent.message.sent',
    timestamp: Date.now(),
    source: 'agent:bench',
    agentId: 'bench',
    severity: 'normal',
    summary: `Bench message ${index}`,
    payload: { text: `Message number ${index}` },
  } as CanonicalEvent;
}

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-viewer-bench-'));
  const file = path.join(dir, 'bench.db');
  const store = new SQLiteEventStore(file, { backup: 'off' });
  try {
    await store.init();
    const startedAt = process.hrtime.bigint();
    for (let i = 0; i < EVENT_COUNT; i++) {
      const result = await store.append(buildEvent(i), { submitterId: 'bench' });
      if (result.outcome !== 'accepted') throw new Error(`Unexpected outcome at event ${i}: ${result.outcome}`);
    }
    const elapsedNs = process.hrtime.bigint() - startedAt;
    const elapsedSeconds = Number(elapsedNs) / 1e9;
    const eventsPerSecond = EVENT_COUNT / elapsedSeconds;
    console.log(`agent-viewer bench-ingest: ${EVENT_COUNT} sequential store.append calls (SQLite, chain enabled)`);
    console.log(`  elapsed: ${elapsedSeconds.toFixed(3)}s`);
    console.log(`  throughput: ${eventsPerSecond.toFixed(1)} events/s`);
    console.log(`  node: ${process.version}, platform: ${os.platform()} ${os.arch()}, cpus: ${os.cpus().length}`);
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
