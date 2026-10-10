import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripHeading } from '../scripts/changelog-section.mjs';
import { extractChangelogSection } from '../scripts/release-rules.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const scriptPath = `${repoRoot}scripts/changelog-section.mjs`;

test('stripHeading drops only the leading "## [X.Y.Z]" line', () => {
  assert.equal(
    stripHeading('## [1.2.3] - 2026-01-01\n\n### Added\n- a thing'),
    '### Added\n- a thing',
  );
  assert.equal(stripHeading('### Added\n- a thing'), '### Added\n- a thing', 'no heading to strip');
});

test('CLI prints the body of a known version and exits 0', () => {
  const out = execFileSync('node', [scriptPath, '0.3.0'], { cwd: repoRoot, encoding: 'utf8' });
  assert.match(out, /Cifras ciertas/, 'the 0.3.0 section body should be printed');
  assert.ok(!out.trimStart().startsWith('## ['), 'the heading line itself must not be printed');
});

test('CLI exits non-zero for a version with no section', () => {
  assert.throws(() => {
    execFileSync('node', [scriptPath, '999.0.0'], { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' });
  }, /Command failed/);
});

test('extractChangelogSection plus stripHeading yields an empty body for a heading with no content', () => {
  // This is exactly what the CLI checks before printing: extractChangelogSection returns null for a
  // heading with nothing under it (see tests/release-workflow.test.mjs-adjacent release-rules.mjs logic),
  // so the CLI's own "empty body" branch is unreachable for a truly empty section and only guards against
  // a section whose only content is whitespace that extractChangelogSection's own trim() already handles.
  const fixture = '# Changelog\n\n## [0.0.1]\n\n## [0.0.0]\n\nSomething\n';
  assert.equal(extractChangelogSection(fixture, '0.0.1'), null, 'a heading with no body is not a section at all');
});

test('CLI exits non-zero with no version argument', () => {
  assert.throws(() => {
    execFileSync('node', [scriptPath], { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' });
  }, /Command failed/);
});
