// Guards the version drift the issue tracking 0.4.0's release step called out by name: wt-cli (0.2.0) and
// main (0.2.1) had already drifted apart before. tests/release-versions.test.mjs already checks
// package.json against sdk/python/pyproject.toml; this file covers the two places that test does not:
// both version fields inside package-lock.json, and the wheel filename hard-coded in
// sdk/python/README.md's "build it yourself" example.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readPyprojectVersion } from '../scripts/release-rules.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function readJson(relativePath) {
  return JSON.parse(readFileSync(`${repoRoot}${relativePath}`, 'utf8'));
}

test('package-lock.json carries the same version as package.json, in both places it appears', () => {
  const packageJson = readJson('package.json');
  const lock = readJson('package-lock.json');

  assert.equal(lock.version, packageJson.version, 'package-lock.json top-level "version" must match package.json');
  assert.equal(
    lock.packages?.['']?.version,
    packageJson.version,
    'package-lock.json packages[""].version must match package.json',
  );
});

test('the wheel filename documented in sdk/python/README.md matches sdk/python/pyproject.toml', () => {
  const pyprojectVersion = readPyprojectVersion(readFileSync(`${repoRoot}sdk/python/pyproject.toml`, 'utf8'));
  const readme = readFileSync(`${repoRoot}sdk/python/README.md`, 'utf8');

  const wheelMatch = /agent_viewer-([^-\s]+)-py3-none-any\.whl/.exec(readme);
  assert.ok(wheelMatch, 'sdk/python/README.md should document the wheel filename it expects pip install to find');
  assert.equal(
    wheelMatch[1],
    pyprojectVersion,
    'the wheel filename in sdk/python/README.md must carry the same version as sdk/python/pyproject.toml',
  );
});

test('CHANGELOG.md has a dated section for the current package.json version', () => {
  const packageJson = readJson('package.json');
  const changelog = readFileSync(`${repoRoot}CHANGELOG.md`, 'utf8');
  const headingRe = new RegExp(`^## \\[${packageJson.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`, 'm');
  assert.match(
    changelog,
    headingRe,
    `CHANGELOG.md must have a "## [${packageJson.version}]" section for the version currently in package.json`,
  );
});
