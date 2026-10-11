// Issue #261 (part of #82): the version string is written by hand in a dozen places (package.json,
// package-lock.json, the Python SDK's pyproject.toml, both READMEs, both library guides, the CHANGELOG)
// and nothing checked that they agreed. `docs/library.md:5` kept saying "covers version 0.2.0" for two
// releases before anyone noticed. This test reads `package.json` as the single source of truth and fails
// the moment any of the other files drifts from it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function read(relativePath) {
  return readFileSync(`${repoRoot}${relativePath}`, 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

const PACKAGE_JSON = 'package.json';
const PACKAGE_LOCK = 'package-lock.json';
const PYPROJECT = 'sdk/python/pyproject.toml';
const README_EN = 'README.md';
const README_ES = 'docs/README.es.md';
const LIBRARY_EN = 'docs/library.md';
const LIBRARY_ES = 'docs/library.es.md';
const CHANGELOG = 'CHANGELOG.md';

const pkg = readJson(PACKAGE_JSON);
const version = pkg.version;

test('package.json declares a valid semantic version', () => {
  assert.match(version, /^\d+\.\d+\.\d+$/, `${PACKAGE_JSON} "version" must be a plain x.y.z string, got "${version}"`);
});

test('package-lock.json matches package.json at both root entries', () => {
  const lock = readJson(PACKAGE_LOCK);
  assert.equal(lock.version, version, `${PACKAGE_LOCK} top-level "version" must match ${PACKAGE_JSON}`);
  assert.equal(
    lock.packages?.['']?.version,
    version,
    `${PACKAGE_LOCK} packages[""].version must match ${PACKAGE_JSON}; run "npm install --package-lock-only" after bumping the version`,
  );
});

test('sdk/python/pyproject.toml matches package.json', () => {
  const toml = read(PYPROJECT);
  const match = toml.match(/^version\s*=\s*"([^"]+)"/m);
  assert.ok(match, `${PYPROJECT} must declare a [project] version string`);
  assert.equal(match[1], version, `${PYPROJECT} version must match ${PACKAGE_JSON}`);
});

function assertVersionOccurrencesMatch(relativePath, patterns) {
  const content = read(relativePath);
  for (const { name, pattern } of patterns) {
    const match = content.match(pattern);
    assert.ok(match, `${relativePath} must contain the ${name} (pattern not found: ${pattern})`);
    assert.equal(match[1], version, `${relativePath} ${name} is "${match[1]}", expected "${version}" to match ${PACKAGE_JSON}`);
  }
}

test('README.md version badge, library version line and install URL match package.json', () => {
  assertVersionOccurrencesMatch(README_EN, [
    { name: 'release badge', pattern: /img\.shields\.io\/badge\/release-v([0-9.]+)-/ },
    { name: 'library version mention', pattern: /\*\*`@warlockcode\/agent-viewer` ([0-9.]+)\*\*/ },
    { name: 'install URL tag', pattern: /releases\/download\/v([0-9.]+)\/warlockcode-agent-viewer-[0-9.]+\.tgz/ },
    { name: 'install URL asset filename', pattern: /releases\/download\/v[0-9.]+\/warlockcode-agent-viewer-([0-9.]+)\.tgz/ },
  ]);
});

test('docs/README.es.md version badge, library version line and install URL match package.json', () => {
  assertVersionOccurrencesMatch(README_ES, [
    { name: 'release badge', pattern: /img\.shields\.io\/badge\/versi%C3%B3n-v([0-9.]+)-/ },
    { name: 'library version mention', pattern: /\*\*`@warlockcode\/agent-viewer` ([0-9.]+)\*\*/ },
    { name: 'install URL tag', pattern: /releases\/download\/v([0-9.]+)\/warlockcode-agent-viewer-[0-9.]+\.tgz/ },
    { name: 'install URL asset filename', pattern: /releases\/download\/v[0-9.]+\/warlockcode-agent-viewer-([0-9.]+)\.tgz/ },
  ]);
});

for (const [relativePath, coversPattern] of [
  [LIBRARY_EN, /covers version \*\*([^*]+)\*\*/],
  [LIBRARY_ES, /cubre la versión \*\*([^*]+)\*\*/],
]) {
  test(`${relativePath} "covers version" line and install URL match package.json`, () => {
    assertVersionOccurrencesMatch(relativePath, [
      { name: '"covers version" line', pattern: coversPattern },
      { name: 'install URL tag', pattern: /releases\/download\/v([0-9.]+)\/warlockcode-agent-viewer-[0-9.]+\.tgz/ },
      { name: 'install URL asset filename', pattern: /releases\/download\/v[0-9.]+\/warlockcode-agent-viewer-([0-9.]+)\.tgz/ },
    ]);
  });
}

test('CHANGELOG.md has an empty [Unreleased] section and its first dated section matches package.json', () => {
  const lines = read(CHANGELOG).split('\n');
  const unreleasedIndex = lines.findIndex((line) => line.trim() === '## [Unreleased]');
  assert.ok(unreleasedIndex >= 0, `${CHANGELOG} must have an "## [Unreleased]" heading`);

  const datedHeading = /^##\s*\[(\d+\.\d+\.\d+)\]\s*-\s*\d{4}-\d{2}-\d{2}/;
  let firstDatedIndex = -1;
  let firstDatedVersion = null;
  for (let i = unreleasedIndex + 1; i < lines.length; i += 1) {
    const match = lines[i].match(datedHeading);
    if (match) {
      firstDatedIndex = i;
      firstDatedVersion = match[1];
      break;
    }
  }
  assert.ok(firstDatedIndex >= 0, `${CHANGELOG} must have at least one dated "## [x.y.z] - YYYY-MM-DD" section after [Unreleased]`);
  assert.equal(
    firstDatedVersion,
    version,
    `${CHANGELOG}'s first dated section is [${firstDatedVersion}], expected [${version}] to match ${PACKAGE_JSON}`,
  );

  const unreleasedBody = lines.slice(unreleasedIndex + 1, firstDatedIndex).join('\n').trim();
  assert.equal(unreleasedBody, '', `${CHANGELOG}'s [Unreleased] section must be empty right after a version release, found: "${unreleasedBody.slice(0, 80)}"`);
});
