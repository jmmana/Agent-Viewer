// Pure logic shared between .github/workflows/release.yml and tests/release-versions.test.mjs,
// so the workflow and its tests never drift apart. Kept dependency-free (Node built-ins only)
// because it also runs as a CLI step inside the release workflow.
//
// CLI usage (all paths are relative to the repository root):
//   node scripts/release-rules.mjs is-prerelease <tag>
//     Exits 0 and prints "true" when <tag> is a prerelease (for example v0.3.0-rc.1),
//     exits 1 and prints "false" otherwise.
//   node scripts/release-rules.mjs check-versions <tag>
//     Reads package.json and sdk/python/pyproject.toml and fails (exit 1, message on stderr)
//     unless both versions equal the tag (without the leading "v").
//   node scripts/release-rules.mjs changelog-section <tag>
//     Prints the CHANGELOG.md section for the tag's base version (prerelease suffix stripped)
//     to stdout. Fails (exit 1) if the section does not exist or is empty.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Parses a release tag such as "v0.3.0" or "v0.3.0-rc.1".
 * Returns null when the tag is not a valid "vX.Y.Z" or "vX.Y.Z-<prerelease>" tag.
 */
export function parseTag(tag) {
  const match = /^v(\d+\.\d+\.\d+)(?:-([0-9A-Za-z.]+))?$/.exec(String(tag ?? ''));
  if (!match) return null;
  const [, version, prereleaseTag] = match;
  return {
    version,
    prereleaseTag: prereleaseTag ?? null,
    full: prereleaseTag ? `${version}-${prereleaseTag}` : version,
  };
}

/**
 * A tag is a prerelease (a dry run that must not publish) when it carries a hyphenated
 * suffix of the form rc.<n>, beta.<n> or alpha.<n> after the semver core, for example
 * v0.3.0-rc.1. A plain "v0.3.0" is never a prerelease.
 */
export function isPrereleaseTag(tag) {
  const parsed = parseTag(tag);
  if (!parsed || !parsed.prereleaseTag) return false;
  return /^(rc|beta|alpha)\.\d+$/.test(parsed.prereleaseTag);
}

/** Extracts the version string declared in a pyproject.toml's [project] table. */
export function readPyprojectVersion(pyprojectContent) {
  const match = /^version\s*=\s*"([^"]+)"/m.exec(pyprojectContent);
  return match ? match[1] : null;
}

/**
 * Checks that package.json's version and sdk/python/pyproject.toml's version both equal
 * the version implied by the tag. Returns { ok: true } or { ok: false, reason }.
 */
export function checkVersionAlignment({ tag, packageJsonVersion, pyprojectVersion }) {
  const parsed = parseTag(tag);
  if (!parsed) {
    return { ok: false, reason: `"${tag}" is not a valid vX.Y.Z or vX.Y.Z-<prerelease> tag.` };
  }
  const expected = parsed.full;
  const errors = [];
  if (packageJsonVersion !== expected) {
    errors.push(
      `package.json version "${packageJsonVersion}" does not match tag "${tag}" (expected "${expected}").`,
    );
  }
  if (pyprojectVersion !== expected) {
    errors.push(
      `sdk/python/pyproject.toml version "${pyprojectVersion}" does not match tag "${tag}" (expected "${expected}").`,
    );
  }
  return errors.length === 0 ? { ok: true } : { ok: false, reason: errors.join(' ') };
}

/**
 * Extracts the "## [X.Y.Z]" section of a Keep a Changelog file for the given version
 * (no leading "v", no prerelease suffix), stopping right before the next "## [" heading.
 * Returns null when the heading does not exist, or the section has no body.
 */
export function extractChangelogSection(changelogContent, version) {
  const lines = changelogContent.split('\n');
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headingRe = new RegExp(`^## \\[${escaped}\\]`);
  const start = lines.findIndex((line) => headingRe.test(line));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^## \[/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const body = lines.slice(start + 1, end).join('\n').trim();
  if (!body) return null;
  return lines.slice(start, end).join('\n').trim();
}

function readJsonVersion(path) {
  const content = readFileSync(path, 'utf8');
  return JSON.parse(content).version;
}

function runCli() {
  const [, , command, arg] = process.argv;

  if (command === 'is-prerelease') {
    const result = isPrereleaseTag(arg);
    process.stdout.write(`${result}\n`);
    process.exit(result ? 0 : 1);
  }

  if (command === 'check-versions') {
    const packageJsonVersion = readJsonVersion(`${REPO_ROOT}package.json`);
    const pyprojectVersion = readPyprojectVersion(
      readFileSync(`${REPO_ROOT}sdk/python/pyproject.toml`, 'utf8'),
    );
    const outcome = checkVersionAlignment({ tag: arg, packageJsonVersion, pyprojectVersion });
    if (!outcome.ok) {
      process.stderr.write(`${outcome.reason}\n`);
      process.exit(1);
    }
    process.stdout.write(`package.json and sdk/python/pyproject.toml both match tag ${arg}.\n`);
    process.exit(0);
  }

  if (command === 'changelog-section') {
    const parsed = parseTag(arg);
    if (!parsed) {
      process.stderr.write(`"${arg}" is not a valid release tag.\n`);
      process.exit(1);
    }
    const changelog = readFileSync(`${REPO_ROOT}CHANGELOG.md`, 'utf8');
    const section = extractChangelogSection(changelog, parsed.version);
    if (!section) {
      process.stderr.write(
        `No "## [${parsed.version}]" section with content found in CHANGELOG.md.\n`,
      );
      process.exit(1);
    }
    process.stdout.write(`${section}\n`);
    process.exit(0);
  }

  process.stderr.write(
    'Usage: node scripts/release-rules.mjs <is-prerelease|check-versions|changelog-section> <tag>\n',
  );
  process.exit(2);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  runCli();
}
