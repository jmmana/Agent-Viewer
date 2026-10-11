// .github/copilot-instructions.md rule: never use the em dash (U+2014). Scoped to the files issue #271 (the
// pricing file store, lifecycle and CLI wiring sub-issue of #83) adds or changes, mirroring the per-issue
// guard pattern of tests/pricing-no-em-dash.test.mjs and tests/no-em-dash.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const EM_DASH = String.fromCharCode(0x2014);

const FILES = [
  'server/pricing/store.ts',
  'tests/pricing-store.test.mjs',
  'cli/start.ts',
  'server/index.ts',
  'server/.env.example',
];

for (const relativePath of FILES) {
  test(`no em dash (U+2014) in ${relativePath}`, () => {
    const content = readFileSync(`${repoRoot}${relativePath}`, 'utf8');
    const lines = content.split('\n');
    const offenders = [];
    lines.forEach((line, index) => {
      if (line.includes(EM_DASH)) offenders.push(`line ${index + 1}: ${line.trim()}`);
    });
    assert.deepEqual(offenders, [], `${relativePath} must not contain an em dash (U+2014)`);
  });
}
