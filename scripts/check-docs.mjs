#!/usr/bin/env node
// Docs hygiene gate for CI (issue #410, sub-issue of #111). Three independent checks, run in this order
// and all reported together before exiting:
//
//   1. Link check: every relative markdown link (and image) inside README.md, the top-level docs/*.md
//      files (including docs/README.es.md) and .github/SECURITY.md must resolve to a real file, and if it
//      carries a `#anchor`, to a real heading in the target file (GitHub's own heading-slug algorithm).
//      Links into subdirectories (docs/adr/, docs/crew/, docs/adapters/, docs/specs/) are followed and
//      checked like any other target; they are just not themselves members of the scanned set, matching
//      the issue's literal "docs/*.md" scope (a non-recursive glob).
//   2. README linkage: every 0.8.0 doc this issue's own text names (docs/audit.md, docs/audit-chain.md,
//      docs/audit-bundle.md, docs/api-keys.md, docs/retention.md, docs/threat-model.md) must be linked
//      from README.md at least once.
//   3. Em dash (U+2014) scan, scoped to files changed since the v0.7.0 tag (git diff v0.7.0..HEAD, added/
//      copied/modified/renamed; a deleted file cannot violate anything). This is deliberately NOT a
//      repo-wide scan: pre-0.7.0 prose nobody has touched since is out of scope for this gate (see the
//      issue's own "Out of scope" section), only new or edited content answers to the "never use an em
//      dash" rule from .github/copilot-instructions.md going forward. A hard, non-regressing boundary: at
//      the time this script was added, every file changed since v0.7.0 was already clean, so this can be a
//      hard CI gate from day one instead of a warning nobody acts on.
//
// Usage: node scripts/check-docs.mjs [--since <git-ref>]
//   --since defaults to v0.7.0. In CI the workflow fetches that one tag before running this script (the
//   checkout is shallow); locally, run `git fetch --tags` first if the tag is missing. A ref that cannot be
//   resolved is a hard failure, not a silently skipped check, so a misconfigured CI step is caught instead
//   of quietly never running check 3.
//
// Exit codes: 0 all clean, 1 at least one violation, 2 usage/environment error (e.g. --since ref not found).

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

// --- scope ------------------------------------------------------------------------------------

/** Top-level docs/*.md files (non-recursive), plus README.md and .github/SECURITY.md, as repo-relative paths. */
export function listScopedMarkdownFiles(repoRoot = REPO_ROOT) {
  const docsDir = join(repoRoot, 'docs');
  const docsFiles = readdirSync(docsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => `docs/${entry.name}`)
    .sort();
  return ['README.md', ...docsFiles, '.github/SECURITY.md'];
}

/** The 0.8.0 docs this issue's own text requires to be linked from README.md. */
export const DOCS_REQUIRING_README_LINKAGE = [
  'docs/audit.md',
  'docs/audit-chain.md',
  'docs/audit-bundle.md',
  'docs/api-keys.md',
  'docs/retention.md',
  'docs/threat-model.md',
];

export const EM_DASH_DEFAULT_SINCE_REF = 'v0.7.0';
const EM_DASH = '—';

// --- markdown link extraction -------------------------------------------------------------------

const LINK_RE = /!?\[[^\]]*\]\(([^)]+)\)/g;

/** Extracts every `[text](target)` / `![alt](target)` target from markdown source, in order. */
export function extractLinkTargets(markdown) {
  const targets = [];
  let match;
  LINK_RE.lastIndex = 0;
  while ((match = LINK_RE.exec(markdown)) !== null) {
    let target = match[1].trim();
    // Drop an optional ` "title"` / ` 'title'` suffix.
    const titleMatch = target.match(/^(\S+)\s+["'].*["']$/);
    if (titleMatch) target = titleMatch[1];
    targets.push(target);
  }
  return targets;
}

/** True for absolute URLs (http:, https:, mailto:, etc.) and protocol-relative (`//host/...`) targets. */
export function isExternalLink(target) {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target) || target.startsWith('//');
}

// --- GitHub-style heading slugs ----------------------------------------------------------------

/**
 * Reimplements GitHub's own Markdown heading-anchor algorithm closely enough for this repo's headings
 * (ASCII text, emoji prefixes, backticks for code spans, no embedded links): strip code-span backticks,
 * drop every character that is not a letter, digit, space, hyphen or underscore, lowercase, then replace
 * each remaining whitespace character with a hyphen individually, without trimming or collapsing runs.
 * That last part is deliberate, not an oversight: GitHub does not trim or collapse, so a heading like
 * "## 🔌 Connect your agents" (emoji removed, its trailing space kept) slugs to "-connect-your-agents"
 * with a leading hyphen, and "## 🔑 5. Idempotency & Replays" slugs to "-5-idempotency--replays" with a
 * doubled hyphen where " & " lost only its ampersand. Both are real anchors this repo's own README and
 * docs/integration.md already link to; a trim-and-collapse version would falsely flag them as broken.
 * Repeats are disambiguated with a numeric suffix (first repeat is `-1`, matching GitHub).
 */
export function githubSlug(headingText, seenCounts) {
  const stripped = headingText
    .replace(/`/g, '')
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .toLowerCase();
  const slug = stripped.replace(/\s/g, '-');
  if (!seenCounts) return slug;
  const count = seenCounts.get(slug) ?? 0;
  seenCounts.set(slug, count + 1);
  return count === 0 ? slug : `${slug}-${count}`;
}

/** Every heading-derived anchor slug in a markdown file, in document order, duplicates disambiguated. */
export function collectHeadingSlugs(markdown) {
  const seenCounts = new Map();
  const slugs = new Set();
  for (const line of markdown.split('\n')) {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (!heading) continue;
    slugs.add(githubSlug(heading[1], seenCounts));
  }
  return slugs;
}

// --- link resolution ------------------------------------------------------------------------

/**
 * Resolves one relative link target found inside `sourceFile` (repo-relative path) against the repo on
 * disk, checking both file existence and, if present, the `#anchor` against the target file's own
 * headings. Returns null when the link is fine, or a short human-readable problem description.
 */
export function checkLinkTarget(sourceFile, target, repoRoot, headingSlugCache) {
  const hashIndex = target.indexOf('#');
  const pathPart = hashIndex === -1 ? target : target.slice(0, hashIndex);
  const anchorPart = hashIndex === -1 ? null : target.slice(hashIndex + 1);

  let resolvedRepoRelativePath;
  if (pathPart === '') {
    // Pure in-page anchor, e.g. "#some-heading".
    resolvedRepoRelativePath = sourceFile;
  } else {
    const sourceDir = dirname(join(repoRoot, sourceFile));
    const absoluteTarget = resolve(sourceDir, pathPart);
    if (!existsSync(absoluteTarget)) {
      return `target file does not exist: ${relative(repoRoot, absoluteTarget)}`;
    }
    if (statSync(absoluteTarget).isDirectory()) {
      return `target is a directory, not a file: ${relative(repoRoot, absoluteTarget)}`;
    }
    resolvedRepoRelativePath = relative(repoRoot, absoluteTarget);
  }

  if (anchorPart === null || anchorPart === '') return null;
  if (!resolvedRepoRelativePath.endsWith('.md')) return null; // anchors into non-markdown files are not checked

  let slugs = headingSlugCache.get(resolvedRepoRelativePath);
  if (!slugs) {
    const absolutePath = join(repoRoot, resolvedRepoRelativePath);
    if (!existsSync(absolutePath)) return `target file does not exist: ${resolvedRepoRelativePath}`;
    slugs = collectHeadingSlugs(readFileSync(absolutePath, 'utf8'));
    headingSlugCache.set(resolvedRepoRelativePath, slugs);
  }
  if (!slugs.has(anchorPart)) {
    return `anchor "#${anchorPart}" has no matching heading in ${resolvedRepoRelativePath}`;
  }
  return null;
}

/** Runs the link check over every scoped file. Returns an array of { file, target, problem } entries. */
export function checkLinks(repoRoot = REPO_ROOT, scopedFiles = listScopedMarkdownFiles(repoRoot)) {
  const problems = [];
  const headingSlugCache = new Map();
  for (const file of scopedFiles) {
    const absolutePath = join(repoRoot, file);
    const markdown = readFileSync(absolutePath, 'utf8');
    for (const target of extractLinkTargets(markdown)) {
      if (isExternalLink(target)) continue;
      const problem = checkLinkTarget(file, target, repoRoot, headingSlugCache);
      if (problem) problems.push({ file, target, problem });
    }
  }
  return problems;
}

// --- README linkage for 0.8.0 docs -----------------------------------------------------------

/** Returns the subset of `docsRequiringLinkage` that README.md does not link to (by relative path, anchor-agnostic). */
export function checkReadmeLinkage(repoRoot = REPO_ROOT, docsRequiringLinkage = DOCS_REQUIRING_README_LINKAGE) {
  const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');
  const linkedPaths = new Set(
    extractLinkTargets(readme)
      .filter((target) => !isExternalLink(target))
      .map((target) => (target.includes('#') ? target.slice(0, target.indexOf('#')) : target)),
  );
  return docsRequiringLinkage.filter((doc) => !linkedPaths.has(doc));
}

// --- em dash scan, scoped to files changed since a ref ----------------------------------------

/** Ensures `ref` resolves locally, attempting one `git fetch` of it as a tag if it does not. Throws on failure. */
function ensureRefAvailable(ref, repoRoot) {
  try {
    execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: repoRoot, stdio: 'pipe' });
    return;
  } catch {
    // fall through to fetch attempt
  }
  try {
    execFileSync('git', ['fetch', '--depth=1', '--no-tags', 'origin', `refs/tags/${ref}:refs/tags/${ref}`], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
  } catch (fetchError) {
    throw new Error(
      `--since ref "${ref}" could not be resolved and fetching it from "origin" failed: ${fetchError.message}`,
    );
  }
  execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: repoRoot, stdio: 'pipe' });
}

/** Repo-relative paths added/copied/modified/renamed between `ref` and HEAD (deletions excluded). */
export function listFilesChangedSince(ref, repoRoot = REPO_ROOT) {
  ensureRefAvailable(ref, repoRoot);
  const output = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMR', `${ref}..HEAD`], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return output.split('\n').filter(Boolean);
}

/** Of the given repo-relative file list, the ones that still exist on disk and contain an em dash. */
export function findEmDashViolations(files, repoRoot = REPO_ROOT) {
  const violations = [];
  for (const file of files) {
    const absolutePath = join(repoRoot, file);
    if (!existsSync(absolutePath) || statSync(absolutePath).isDirectory()) continue;
    let content;
    try {
      content = readFileSync(absolutePath, 'utf8');
    } catch {
      continue; // binary or unreadable; not a doc this gate cares about
    }
    if (content.includes(EM_DASH)) violations.push(file);
  }
  return violations;
}

// --- CLI ---------------------------------------------------------------------------------------

function parseArgs(argv) {
  let since = EM_DASH_DEFAULT_SINCE_REF;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--since') {
      since = argv[i + 1];
      i++;
    }
  }
  return { since };
}

function runCli() {
  const { since } = parseArgs(process.argv.slice(2));
  let failed = false;

  const linkProblems = checkLinks(REPO_ROOT);
  if (linkProblems.length > 0) {
    failed = true;
    console.error(`\nBroken relative links/anchors (${linkProblems.length}):`);
    for (const { file, target, problem } of linkProblems) {
      console.error(`  ${file}: "${target}" -> ${problem}`);
    }
  }

  const missingLinkage = checkReadmeLinkage(REPO_ROOT);
  if (missingLinkage.length > 0) {
    failed = true;
    console.error(`\n0.8.0 docs not linked from README.md (${missingLinkage.length}):`);
    for (const doc of missingLinkage) {
      console.error(`  ${doc}`);
    }
  }

  let emDashFiles;
  try {
    emDashFiles = findEmDashViolations(listFilesChangedSince(since, REPO_ROOT), REPO_ROOT);
  } catch (error) {
    console.error(`\nCould not run the em dash scan: ${error.message}`);
    process.exit(2);
  }
  if (emDashFiles.length > 0) {
    failed = true;
    console.error(`\nEm dash (U+2014) found in files changed since ${since} (${emDashFiles.length}):`);
    for (const file of emDashFiles) {
      console.error(`  ${file}`);
    }
    console.error('  Use a comma, colon, parentheses or a plain hyphen instead (see .github/copilot-instructions.md).');
  }

  if (failed) {
    console.error('\ncheck:docs failed.');
    process.exit(1);
  }
  console.log('check:docs passed: links resolve, every 0.8.0 doc is linked from README.md, no new em dashes.');
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  runCli();
}
