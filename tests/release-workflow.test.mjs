import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extractChangelogSection } from '../scripts/release-rules.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const workflowPath = `${repoRoot}.github/workflows/release.yml`;
const workflow = readFileSync(workflowPath, 'utf8');

// release.yml has no YAML parser dependency in this project, and job bodies are shell scripts
// that a generic YAML parser would hand back as opaque strings anyway. Instead this file slices
// the raw text into job blocks by their 2-space-indented job keys under `jobs:`, which is enough
// to assert on structure (job names, `needs`, conditionals) and to grep each job's shell scripts
// for the specific fail-closed and prerelease-gating patterns the pipeline depends on.
function getJobBlock(yaml, jobName) {
  const jobsIndex = yaml.indexOf('\njobs:');
  assert.notEqual(jobsIndex, -1, 'release.yml must have a top-level jobs: key');
  const afterJobs = yaml.slice(jobsIndex + 1);
  const jobHeaderRe = /^ {2}([a-zA-Z_][\w-]*):\s*$/gm;
  const headers = [...afterJobs.matchAll(jobHeaderRe)];
  const match = headers.find((h) => h[1] === jobName);
  assert.ok(match, `expected a "${jobName}:" job in release.yml`);
  const start = match.index + match[0].length;
  const next = headers.find((h) => h.index > match.index);
  const end = next ? next.index : afterJobs.length;
  return afterJobs.slice(start, end);
}

function getStepBlock(jobBlock, stepName) {
  const stepHeaderRe = new RegExp(`- name: ${stepName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`);
  const match = stepHeaderRe.exec(jobBlock);
  assert.ok(match, `expected a "${stepName}" step`);
  const start = match.index + match[0].length;
  const nextStep = /\n {6}- name: /.exec(jobBlock.slice(start));
  const end = nextStep ? start + nextStep.index : jobBlock.length;
  return jobBlock.slice(start, end);
}

test('release.yml defines the release, pypi and docker jobs', () => {
  for (const jobName of ['release', 'pypi', 'docker']) {
    getJobBlock(workflow, jobName);
  }
});

test('release.yml triggers on version tags and supports a manual re-run', () => {
  assert.match(workflow, /on:\n {2}push:\n {4}tags:\n {6}- 'v\*'/);
  assert.match(workflow, /workflow_dispatch:/, 'a manual re-run trigger is required for retrying a failed publish');
});

test('the pypi and docker jobs depend on the release job (version check, build, GitHub release)', () => {
  const pypiBlock = getJobBlock(workflow, 'pypi');
  assert.match(pypiBlock, /needs:\s*release/);

  const dockerBlock = getJobBlock(workflow, 'docker');
  assert.match(dockerBlock, /needs:\s*\[\s*release\s*,\s*pypi\s*\]/, 'docker must wait for both npm and PyPI to finish before pushing');
});

test('the release job exposes a reusable is_prerelease output other jobs read', () => {
  const releaseBlock = getJobBlock(workflow, 'release');
  assert.match(releaseBlock, /outputs:\s*\n\s*is_prerelease:\s*\$\{\{\s*steps\.prerelease\.outputs\.is_prerelease\s*\}\}/);

  const pypiBlock = getJobBlock(workflow, 'pypi');
  assert.match(pypiBlock, /needs\.release\.outputs\.is_prerelease/, 'pypi must gate on the shared prerelease output');

  const dockerBlock = getJobBlock(workflow, 'docker');
  assert.match(dockerBlock, /needs\.release\.outputs\.is_prerelease/, 'docker must gate on the shared prerelease output');
});

test('the version check step covers both package.json and sdk/python/pyproject.toml', () => {
  const releaseBlock = getJobBlock(workflow, 'release');
  const step = getStepBlock(releaseBlock, 'Check version matches tag');
  assert.match(step, /release-rules\.mjs check-versions/, 'the version check must use the shared script, not a package.json-only check');
});

test('the npm publish step fails a real tag instead of silently exiting 0 when the token is missing', () => {
  const releaseBlock = getJobBlock(workflow, 'release');
  const step = getStepBlock(releaseBlock, 'Publish to npm');

  // The prerelease branch is an intentional, logged exit 0 (dry run, not an error).
  assert.match(step, /IS_PRERELEASE.*=.*true[\s\S]*?exit 0/, 'a prerelease tag must skip npm publish cleanly');
  // The missing-token branch on a real tag must fail the job, not exit 0.
  const missingTokenCheckIndex = step.indexOf('-z "$NODE_AUTH_TOKEN"');
  assert.notEqual(missingTokenCheckIndex, -1, 'expected an explicit NODE_AUTH_TOKEN presence check');
  const missingTokenBranch = step.slice(missingTokenCheckIndex);
  assert.match(missingTokenBranch, /exit 1/, 'a missing NPM_TOKEN on a real release tag must fail the job');
  assert.doesNotMatch(
    missingTokenBranch.slice(0, missingTokenBranch.indexOf('exit 1')),
    /exit 0/,
    'the missing-token branch must not exit 0 before failing',
  );
});

test('a missing npm or PyPI credential never blocks the GitHub release or the Docker images', () => {
  const releaseBlock = getJobBlock(workflow, 'release');
  const npmStep = getStepBlock(releaseBlock, 'Publish to npm');
  assert.match(npmStep, /^\s*continue-on-error: true/m, 'npm publish must not fail the release job (it would skip the pypi/docker jobs that need it)');

  const pypiBlock = getJobBlock(workflow, 'pypi');
  const pypiPublishStep = getStepBlock(pypiBlock, 'Publish to PyPI');
  assert.match(pypiPublishStep, /^\s*continue-on-error: true/m, 'PyPI publish must not fail the pypi job (it would skip the docker job that needs it)');
});

test('a PyPI publish job exists, builds from sdk/python/, and is gated by the prerelease output', () => {
  const pypiBlock = getJobBlock(workflow, 'pypi');
  assert.match(pypiBlock, /python -m build sdk\/python/, 'the sdist/wheel must be built from sdk/python/');
  assert.match(pypiBlock, /twine check/, 'the built distribution must be checked before publishing');
  assert.match(pypiBlock, /pypa\/gh-action-pypi-publish/, 'PyPI publishing must use the trusted-publishing action');

  const publishStep = getStepBlock(pypiBlock, 'Publish to PyPI');
  assert.match(publishStep, /if: needs\.release\.outputs\.is_prerelease != 'true'/, 'PyPI must not publish on a prerelease tag');
});

test('the GHCR docker push is conditional on the tag not being a prerelease', () => {
  const dockerBlock = getJobBlock(workflow, 'docker');
  const officeImageStep = getStepBlock(dockerBlock, 'Build (and push on a real release) the office + API image');
  assert.match(officeImageStep, /push: \$\{\{\s*needs\.release\.outputs\.is_prerelease != 'true'\s*\}\}/);

  const apiImageStep = getStepBlock(dockerBlock, 'Build (and push on a real release) the API image');
  assert.match(apiImageStep, /push: \$\{\{\s*needs\.release\.outputs\.is_prerelease != 'true'\s*\}\}/);
});

test('the GitHub release notes are extracted from CHANGELOG.md instead of a fixed string', () => {
  const releaseBlock = getJobBlock(workflow, 'release');
  assert.doesNotMatch(releaseBlock, /--notes\s+"See CHANGELOG\.md"/, 'the fixed release-notes string must be gone');
  assert.match(releaseBlock, /release-rules\.mjs changelog-section/, 'notes must come from the shared changelog-extraction logic');
  assert.match(releaseBlock, /--notes-file release-notes\.md/);
});

test('a prerelease tag gets a GitHub prerelease, not a normal public release', () => {
  const releaseBlock = getJobBlock(workflow, 'release');
  const step = getStepBlock(releaseBlock, 'Create or update the GitHub release');
  assert.match(step, /--prerelease/);
  assert.match(step, /IS_PRERELEASE/);
});

test('extractChangelogSection pulls the right section and stops at the next heading', () => {
  const changelog = [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    '## [0.3.0] - 2026-10-09',
    '',
    'First line of the 0.3.0 notes.',
    '',
    '### Breaking changes',
    '',
    '- Something changed.',
    '',
    '## [0.2.1] - 2026-09-01',
    '',
    'Older notes that must not leak into the 0.3.0 section.',
    '',
  ].join('\n');

  const section = extractChangelogSection(changelog, '0.3.0');
  assert.match(section, /^## \[0\.3\.0\] - 2026-10-09/);
  assert.match(section, /First line of the 0\.3\.0 notes\./);
  assert.match(section, /Something changed\./);
  assert.doesNotMatch(section, /Older notes that must not leak/);

  assert.equal(extractChangelogSection(changelog, '9.9.9'), null, 'a missing version section is null');
  assert.equal(
    extractChangelogSection('## [1.0.0]\n\n## [0.9.0]\nnotes', '1.0.0'),
    null,
    'a heading with no body is treated as empty',
  );
});

test('the real CHANGELOG.md has a non-empty section for the version currently in package.json', () => {
  const changelog = readFileSync(`${repoRoot}CHANGELOG.md`, 'utf8');
  const packageJson = JSON.parse(readFileSync(`${repoRoot}package.json`, 'utf8'));
  const baseVersion = packageJson.version.split('-')[0];
  const section = extractChangelogSection(changelog, baseVersion);
  assert.ok(section, `CHANGELOG.md must have a non-empty "## [${baseVersion}]" section for the release workflow to extract`);
});
