// Issue #259 (part of #82): docs/library.md and docs/library.es.md must stay in lockstep, section by
// section, so a reader switching language never lands on a different chapter or a stale translation. This
// guard is structural, not semantic: it does not check that the translation is correct, only that the two
// files have the same shape (same headings in the same order, same line count, same number of fenced code
// blocks), and that neither one carries a literal em dash (the project style rule, see AGENTS instructions
// and .github/copilot-instructions.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const EM_DASH = '—';

const EN_PATH = 'docs/library.md';
const ES_PATH = 'docs/library.es.md';

function readLines(relativePath) {
  return readFileSync(`${repoRoot}${relativePath}`, 'utf8').split('\n');
}

function headingLevels(lines) {
  return lines.filter((line) => /^#{1,6}\s/.test(line)).map((line) => line.match(/^(#{1,6})\s/)[1]);
}

function codeFenceCount(lines) {
  return lines.filter((line) => line.startsWith('```')).length;
}

const enLines = readLines(EN_PATH);
const esLines = readLines(ES_PATH);

test('the library guides have the same number of lines', () => {
  assert.equal(
    enLines.length,
    esLines.length,
    `${EN_PATH} has ${enLines.length} lines, ${ES_PATH} has ${esLines.length}; they must match so neither guide drifts ahead of the other`,
  );
});

test('the library guides have the same heading levels in the same order', () => {
  assert.deepEqual(
    headingLevels(enLines),
    headingLevels(esLines),
    'the sequence of #/##/###/... heading levels must be identical between languages, even though the heading text itself is translated',
  );
});

test('the library guides have the same number of fenced code blocks', () => {
  assert.equal(
    codeFenceCount(enLines),
    codeFenceCount(esLines),
    'a code example missing from one language means an integrator reading that language gets less than the other',
  );
});

for (const relativePath of [EN_PATH, ES_PATH]) {
  test(`${relativePath} contains no em dash (U+2014)`, () => {
    const content = readFileSync(`${repoRoot}${relativePath}`, 'utf8');
    assert.ok(!content.includes(EM_DASH), `${relativePath} must not contain the em dash character`);
  });
}

test('both guides declare the same "covers version" line', () => {
  const versionLine = /covers version \*\*([^*]+)\*\*|cubre la versión \*\*([^*]+)\*\*/;
  const enMatch = enLines.find((line) => versionLine.test(line));
  const esMatch = esLines.find((line) => versionLine.test(line));
  assert.ok(enMatch, `${EN_PATH} must state the version it covers near the top of the file`);
  assert.ok(esMatch, `${ES_PATH} must state the version it covers near the top of the file`);
  const enVersion = enMatch.match(versionLine)[1];
  const esVersion = esMatch.match(versionLine)[2];
  assert.equal(enVersion, esVersion, 'both guides must declare the same covered version');
});

test('both guides reference the same install asset version', () => {
  const urlPattern = /releases\/download\/v([0-9.]+)\/warlockcode-agent-viewer-([0-9.]+)\.tgz/;
  const enMatch = enLines.find((line) => urlPattern.test(line));
  const esMatch = esLines.find((line) => urlPattern.test(line));
  assert.ok(enMatch, `${EN_PATH} must document the install command with a release asset URL`);
  assert.ok(esMatch, `${ES_PATH} must document the install command with a release asset URL`);
  const [, enTag, enFile] = enMatch.match(urlPattern);
  const [, esTag, esFile] = esMatch.match(urlPattern);
  assert.equal(enTag, enFile, 'the tag and the asset filename version must agree within a guide');
  assert.equal(enTag, esTag, 'both guides must point at the same release tag');
  assert.equal(enFile, esFile, 'both guides must point at the same asset filename');
});
