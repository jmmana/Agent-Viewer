// .github/copilot-instructions.md rule: never use the em dash (U+2014) in code, docs, commits or PRs.
// Scoped to the files issue #75 actually adds or changes, not the whole repository: docs/usage-export.md
// and docs/retention.md, for example, belong to issues #69/#70 and are out of this item's declared scope
// (see its own "Documentation" section), so a pre-existing em dash there is not this test's concern.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const EM_DASH = '—';

const FILES = [
  'README.md',
  'docs/README.es.md',
  'docs/integration.md',
  'docs/cli.md',
  'docs/event-log.md',
  'docs/library.md',
  'docs/library.es.md',
  'docs/usage-ledger.md',
  'docs/redaction.md',
  'docs/migrating-to-0.4.md',
  '.github/SECURITY.md',
  'sdk/python/README.md',
  'CHANGELOG.md',
];

for (const relativePath of FILES) {
  test(`no em dash (U+2014) in ${relativePath}`, () => {
    const content = readFileSync(`${repoRoot}${relativePath}`, 'utf8');
    const lines = content.split('\n');
    const offenders = [];
    lines.forEach((line, index) => {
      if (line.includes(EM_DASH)) {
        offenders.push(`line ${index + 1}: ${line.trim()}`);
      }
    });
    assert.deepEqual(offenders, [], `${relativePath} must not contain an em dash (U+2014)`);
  });
}
