import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REPO_ROOT,
  extractLinkTargets,
  isExternalLink,
  githubSlug,
  collectHeadingSlugs,
  checkLinks,
  checkReadmeLinkage,
  listFilesChangedSince,
  findEmDashViolations,
} from '../scripts/check-docs.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const scriptPath = `${repoRoot}scripts/check-docs.mjs`;

function makeFixtureRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-viewer-check-docs-'));
  mkdirSync(join(dir, 'docs'));
  mkdirSync(join(dir, '.github'));
  return dir;
}

function write(dir, relativePath, content) {
  writeFileSync(join(dir, relativePath), content, 'utf8');
}

// --- extractLinkTargets / isExternalLink -------------------------------------------------------

test('extractLinkTargets finds inline links and images, ignores plain text', () => {
  const md = 'See [a guide](docs/foo.md) and ![a diagram](assets/x.png) in this paragraph.';
  assert.deepEqual(extractLinkTargets(md), ['docs/foo.md', 'assets/x.png']);
});

test('extractLinkTargets strips an optional "title" suffix', () => {
  const md = '[link](docs/foo.md "a title")';
  assert.deepEqual(extractLinkTargets(md), ['docs/foo.md']);
});

test('isExternalLink recognizes schemes and protocol-relative URLs, not relative paths or anchors', () => {
  assert.equal(isExternalLink('https://example.com'), true);
  assert.equal(isExternalLink('mailto:a@b.com'), true);
  assert.equal(isExternalLink('//example.com/x'), true);
  assert.equal(isExternalLink('docs/foo.md'), false);
  assert.equal(isExternalLink('#some-heading'), false);
  assert.equal(isExternalLink('../README.md#section'), false);
});

// --- githubSlug: two real anchors this repo's own docs already rely on --------------------------

test('githubSlug matches GitHub exactly for a heading with inline code and punctuation', () => {
  // docs/integration.md's "### Usage rollup (`GET /api/v1/usage/rollup`, issue #66)" heading, linked
  // from README.md as docs/integration.md#usage-rollup-get-apiv1usagerollup-issue-66.
  assert.equal(
    githubSlug('Usage rollup (`GET /api/v1/usage/rollup`, issue #66)'),
    'usage-rollup-get-apiv1usagerollup-issue-66',
  );
});

test('githubSlug keeps a leading hyphen left behind by a stripped leading emoji (no trim)', () => {
  // README.md's "## 🔌 Connect your agents" heading, linked as #-connect-your-agents.
  assert.equal(githubSlug('🔌 Connect your agents'), '-connect-your-agents');
});

test('githubSlug keeps a doubled hyphen where " & " loses only its ampersand (no run-collapsing)', () => {
  // docs/integration.md's "## 🔑 5. Idempotency & Replays" heading, linked as #-5-idempotency--replays.
  assert.equal(githubSlug('🔑 5. Idempotency & Replays'), '-5-idempotency--replays');
});

test('githubSlug disambiguates repeated headings the way GitHub does (first repeat gets -1)', () => {
  const seen = new Map();
  assert.equal(githubSlug('Overview', seen), 'overview');
  assert.equal(githubSlug('Overview', seen), 'overview-1');
  assert.equal(githubSlug('Overview', seen), 'overview-2');
});

test('collectHeadingSlugs reads every heading level and ignores non-heading lines', () => {
  const md = '# Title\n\nSome text # not a heading (no leading hash at line start... wait it is)\n\n## Sub `code`\n';
  const slugs = collectHeadingSlugs(md);
  assert.ok(slugs.has('title'));
  assert.ok(slugs.has('sub-code'));
});

// --- checkLinks: fixture repo ---------------------------------------------------------------

test('checkLinks: a relative link to a missing file is reported', () => {
  const dir = makeFixtureRepo();
  try {
    write(dir, 'README.md', 'See [missing](docs/missing.md).\n');
    const problems = checkLinks(dir, ['README.md']);
    assert.equal(problems.length, 1);
    assert.match(problems[0].problem, /does not exist/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkLinks: a relative link to a real file with no anchor is fine', () => {
  const dir = makeFixtureRepo();
  try {
    write(dir, 'docs/foo.md', '# Foo\n');
    write(dir, 'README.md', 'See [foo](docs/foo.md).\n');
    assert.deepEqual(checkLinks(dir, ['README.md']), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkLinks: an anchor matching a real heading passes, a bogus one fails', () => {
  const dir = makeFixtureRepo();
  try {
    write(dir, 'docs/foo.md', '# Foo\n\n## A Section\n');
    write(dir, 'README.md', 'See [good](docs/foo.md#a-section) and [bad](docs/foo.md#nope).\n');
    const problems = checkLinks(dir, ['README.md']);
    assert.equal(problems.length, 1);
    assert.equal(problems[0].target, 'docs/foo.md#nope');
    assert.match(problems[0].problem, /no matching heading/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkLinks: a pure in-page anchor resolves against the source file itself', () => {
  const dir = makeFixtureRepo();
  try {
    write(dir, 'README.md', '## Table of contents\n\nSee [toc](#table-of-contents) and [bad](#nowhere).\n');
    const problems = checkLinks(dir, ['README.md']);
    assert.equal(problems.length, 1);
    assert.equal(problems[0].target, '#nowhere');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkLinks: external links (http, mailto) are never checked', () => {
  const dir = makeFixtureRepo();
  try {
    write(dir, 'README.md', '[site](https://example.com/nope) [mail](mailto:a@b.com)\n');
    assert.deepEqual(checkLinks(dir, ['README.md']), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkLinks: a link into a non-markdown file is checked for existence but not for an anchor', () => {
  const dir = makeFixtureRepo();
  try {
    mkdirSync(join(dir, 'docs', 'assets'));
    write(dir, 'docs/assets/banner.svg', '<svg></svg>');
    write(dir, 'README.md', '![banner](docs/assets/banner.svg#ignored-anchor)\n');
    assert.deepEqual(checkLinks(dir, ['README.md']), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- checkReadmeLinkage -----------------------------------------------------------------------

test('checkReadmeLinkage reports a required doc missing from README.md', () => {
  const dir = makeFixtureRepo();
  try {
    write(dir, 'README.md', 'See [a](docs/a.md) but nothing about b.\n');
    const missing = checkReadmeLinkage(dir, ['docs/a.md', 'docs/b.md']);
    assert.deepEqual(missing, ['docs/b.md']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkReadmeLinkage matches a doc linked with an anchor (anchor-agnostic)', () => {
  const dir = makeFixtureRepo();
  try {
    write(dir, 'README.md', 'See [a](docs/a.md#some-section).\n');
    assert.deepEqual(checkReadmeLinkage(dir, ['docs/a.md']), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- findEmDashViolations ---------------------------------------------------------------------

test('findEmDashViolations flags a file containing U+2014 and ignores a clean one', () => {
  const dir = makeFixtureRepo();
  try {
    write(dir, 'docs/bad.md', 'This uses an em dash — right there.\n');
    write(dir, 'docs/good.md', 'This uses a comma, not that character.\n');
    const violations = findEmDashViolations(['docs/bad.md', 'docs/good.md'], dir);
    assert.deepEqual(violations, ['docs/bad.md']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('findEmDashViolations skips a path that does not exist on disk', () => {
  const dir = makeFixtureRepo();
  try {
    assert.deepEqual(findEmDashViolations(['docs/never-created.md'], dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- listFilesChangedSince: real git history, no network needed for a same-ref diff ------------

test('listFilesChangedSince returns an empty list comparing HEAD against itself', () => {
  assert.deepEqual(listFilesChangedSince('HEAD', repoRoot), []);
});

// --- CLI, against the real repo -----------------------------------------------------------------

test('CLI passes against the real repo state and prints a success message', () => {
  const out = execFileSync('node', [scriptPath], { cwd: repoRoot, encoding: 'utf8' });
  assert.match(out, /check:docs passed/);
});

test('CLI accepts --since and still passes comparing HEAD against itself (no em dash can be "new")', () => {
  const out = execFileSync('node', [scriptPath, '--since', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  assert.match(out, /check:docs passed/);
});

test('CLI exits 2 with a clear message when --since names a ref that cannot be resolved or fetched', () => {
  assert.throws(
    () => {
      execFileSync('node', [scriptPath, '--since', 'definitely-not-a-real-ref-or-tag'], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: 'pipe',
      });
    },
    (error) => {
      assert.equal(error.status, 2);
      assert.match(error.stderr.toString(), /could not run the em dash scan/i);
      return true;
    },
  );
});

test('REPO_ROOT points at the actual repository root (package.json exists there)', () => {
  execFileSync('node', ['-e', `require('fs').accessSync(${JSON.stringify(join(REPO_ROOT, 'package.json'))})`]);
});
