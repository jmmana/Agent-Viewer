// Issue #71 removed `?token=`/`?api_key=` as a supported way to authenticate against /api/v1 and
// /v1/logs. No doc in the current, forward-looking set should describe it as supported any more; only
// CHANGELOG.md (history) and docs/migrating-to-0.4.md (which documents the removal itself, before/after)
// are allowed to mention the pattern, since both need to show the old, now-rejected form.
//
// Matches `?token=`/`&token=`/`?api_key=`/`&api_key=` (including the `token[]=` array form the server
// itself also rejects), but not the bare text `api_key=` used as a Python constructor keyword argument
// (`docs/integration.md`'s quickstart) or the `#token=`/`#launch=` URL fragment the CLI and demo app still
// use on purpose (fragments are never sent to the server, so they were never the vulnerability).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const FILES = [
  'README.md',
  'docs/README.es.md',
  'docs/cli.md',
  'docs/library.md',
  'docs/library.es.md',
  'docs/integration.md',
  'docs/usage-ledger.md',
  'docs/redaction.md',
  '.github/SECURITY.md',
];

const FORBIDDEN_PATTERN = /[?&](token|api_key)(\[[^\]]*\])?=/;

for (const relativePath of FILES) {
  test(`${relativePath} never describes ?token=/?api_key= as a supported auth method`, () => {
    const content = readFileSync(`${repoRoot}${relativePath}`, 'utf8');
    const lines = content.split('\n');
    const offenders = [];
    lines.forEach((line, index) => {
      if (FORBIDDEN_PATTERN.test(line)) {
        offenders.push(`line ${index + 1}: ${line.trim()}`);
      }
    });
    assert.deepEqual(offenders, [], `${relativePath} must not describe a query-string token/api_key parameter as supported`);
  });
}

test('CHANGELOG.md and docs/migrating-to-0.4.md are allowed to mention the removed pattern', () => {
  const changelog = readFileSync(`${repoRoot}CHANGELOG.md`, 'utf8');
  const migration = readFileSync(`${repoRoot}docs/migrating-to-0.4.md`, 'utf8');
  assert.match(changelog, FORBIDDEN_PATTERN, 'the breaking-change history should still name the removed pattern');
  assert.match(migration, FORBIDDEN_PATTERN, 'the migration guide should show the removed pattern as "before"');
});
