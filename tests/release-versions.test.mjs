import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  parseTag,
  isPrereleaseTag,
  readPyprojectVersion,
  checkVersionAlignment,
} from '../scripts/release-rules.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

test('parseTag reads the semver core and the optional prerelease suffix', () => {
  assert.deepEqual(parseTag('v0.3.0'), { version: '0.3.0', prereleaseTag: null, full: '0.3.0' });
  assert.deepEqual(parseTag('v0.3.0-rc.1'), {
    version: '0.3.0',
    prereleaseTag: 'rc.1',
    full: '0.3.0-rc.1',
  });
  assert.equal(parseTag('not-a-tag'), null);
  assert.equal(parseTag('0.3.0'), null, 'the leading v is required');
  assert.equal(parseTag('v0.3'), null, 'a full major.minor.patch is required');
});

test('isPrereleaseTag only accepts the documented rc/beta/alpha suffixes', () => {
  assert.equal(isPrereleaseTag('v0.3.0'), false);
  assert.equal(isPrereleaseTag('v0.3.0-rc.1'), true);
  assert.equal(isPrereleaseTag('v0.3.0-beta.2'), true);
  assert.equal(isPrereleaseTag('v0.3.0-alpha.10'), true);
  assert.equal(isPrereleaseTag('v0.3.0-rc'), false, 'the .<n> suffix is required');
  assert.equal(isPrereleaseTag('v0.3.0-nightly.1'), false, 'unknown prerelease labels are not a dry run');
  assert.equal(isPrereleaseTag('not-a-tag'), false);
});

test('readPyprojectVersion extracts the [project] version field', () => {
  const content = [
    '[build-system]',
    'requires = ["setuptools>=77.0"]',
    '',
    '[project]',
    'name = "agent-viewer"',
    'version = "0.3.0"',
    'description = "Python client SDK"',
  ].join('\n');
  assert.equal(readPyprojectVersion(content), '0.3.0');
  assert.equal(readPyprojectVersion('[project]\nname = "x"\n'), null);
});

test('checkVersionAlignment passes only when both files match the tag', () => {
  const aligned = checkVersionAlignment({
    tag: 'v0.3.0',
    packageJsonVersion: '0.3.0',
    pyprojectVersion: '0.3.0',
  });
  assert.deepEqual(aligned, { ok: true });

  const prereleaseAligned = checkVersionAlignment({
    tag: 'v0.3.0-rc.1',
    packageJsonVersion: '0.3.0-rc.1',
    pyprojectVersion: '0.3.0-rc.1',
  });
  assert.deepEqual(prereleaseAligned, { ok: true });

  const packageMismatch = checkVersionAlignment({
    tag: 'v0.3.0',
    packageJsonVersion: '0.2.1',
    pyprojectVersion: '0.3.0',
  });
  assert.equal(packageMismatch.ok, false);
  assert.match(packageMismatch.reason, /package\.json version "0\.2\.1" does not match tag "v0\.3\.0"/);

  const pyprojectMismatch = checkVersionAlignment({
    tag: 'v0.3.0',
    packageJsonVersion: '0.3.0',
    pyprojectVersion: '0.2.1',
  });
  assert.equal(pyprojectMismatch.ok, false);
  assert.match(
    pyprojectMismatch.reason,
    /sdk\/python\/pyproject\.toml version "0\.2\.1" does not match tag "v0\.3\.0"/,
  );

  const invalidTag = checkVersionAlignment({
    tag: 'not-a-tag',
    packageJsonVersion: '0.3.0',
    pyprojectVersion: '0.3.0',
  });
  assert.equal(invalidTag.ok, false);
});

test('package.json and sdk/python/pyproject.toml currently declare the same version', () => {
  // This is the actual release-day check: the npm package and the Python SDK must ship in lockstep.
  const packageJson = JSON.parse(readFileSync(`${repoRoot}package.json`, 'utf8'));
  const pyprojectContent = readFileSync(`${repoRoot}sdk/python/pyproject.toml`, 'utf8');
  const pyprojectVersion = readPyprojectVersion(pyprojectContent);

  assert.ok(packageJson.version, 'package.json must declare a version');
  assert.ok(pyprojectVersion, 'sdk/python/pyproject.toml must declare a [project] version');
  assert.equal(
    packageJson.version,
    pyprojectVersion,
    'package.json and sdk/python/pyproject.toml must carry the same version so a tag can publish both',
  );

  const result = checkVersionAlignment({
    tag: `v${packageJson.version}`,
    packageJsonVersion: packageJson.version,
    pyprojectVersion,
  });
  assert.deepEqual(result, { ok: true });
});
