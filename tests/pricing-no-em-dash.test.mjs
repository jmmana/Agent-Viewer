// .github/copilot-instructions.md rule: never use the em dash (U+2014) in code, docs, commits or PRs.
// Scoped to the files this sub-issue of #83 actually adds (contract, resolver, starter table and their
// tests), mirroring the pattern in tests/no-em-dash.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const EM_DASH = String.fromCharCode(0x2014);

const FILES = [
  'src/integrations/pricingContract.ts',
  'server/pricing/starter.json',
  'tests/pricing-contract.test.mjs',
  'tests/pricing-resolve.test.mjs',
  'tests/pricing-starter.test.mjs',
  'tests/lib/pricingIsolation.test.ts',
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
