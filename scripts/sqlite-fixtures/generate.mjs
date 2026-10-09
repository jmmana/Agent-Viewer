#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [ref, outputPath] = process.argv.slice(2);
if (!ref || !outputPath) {
  console.error('Usage: node scripts/sqlite-fixtures/generate.mjs <git-ref> <out.db>');
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-viewer-sqlite-fixture-'));
const worktree = path.join(temporaryRoot, 'source');
const output = path.resolve(root, outputPath);
fs.mkdirSync(path.dirname(output), { recursive: true });

try {
  execFileSync('git', ['worktree', 'add', '--detach', worktree, ref], { cwd: root, stdio: 'inherit' });
  const eventsPath = path.join(root, 'tests/fixtures/sqlite/events.json');
  const storePath = pathToFileURL(path.join(worktree, 'server/store.ts')).href;
  const code = `
    import fs from 'node:fs';
    import { DatabaseSync } from 'node:sqlite';
    import { SQLiteEventStore } from ${JSON.stringify(storePath)};
    const store = new SQLiteEventStore(${JSON.stringify(output)});
    const events = JSON.parse(fs.readFileSync(${JSON.stringify(eventsPath)}, 'utf8'));
    for (const event of events) {
      if (event.payload.text === '__FIXTURE_LARGE_PAYLOAD__') {
        event.payload.text = '0123456789abcdef'.repeat(512);
      }
      await store.append(event);
    }
    await store.close();
    const db = new DatabaseSync(${JSON.stringify(output)});
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
  `;
  execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    cwd: root,
    stdio: 'inherit',
  });
  const hash = execFileSync('sha256sum', [output], { encoding: 'utf8' }).trim().split(/\s+/)[0];
  console.log(`Created ${output} from ${ref} (${hash})`);
} finally {
  try {
    execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: root, stdio: 'ignore' });
  } catch {
    // The worktree may not have been created.
  }
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
