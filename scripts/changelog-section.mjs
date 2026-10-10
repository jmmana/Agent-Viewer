// Prints the body (no "## [X.Y.Z]" heading) of one CHANGELOG.md section, for a plain version such as
// "0.4.0" (no leading "v", no prerelease suffix). Exits non-zero with a message on stderr when the
// section does not exist or has no body. Reuses `extractChangelogSection` from `release-rules.mjs` (which
// the release workflow already relies on to build GitHub release notes) rather than re-implementing the
// same parsing twice; this script differs only in printing the body alone, without the heading line,
// since a changelog body is what gets embedded elsewhere (for example a release announcement), while the
// release workflow wants the heading too.
//
// CLI usage:
//   node scripts/changelog-section.mjs <version>
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extractChangelogSection } from './release-rules.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Strips the leading "## [X.Y.Z] - ..." heading line a section starts with, if present. */
export function stripHeading(section) {
  const lines = section.split('\n');
  if (lines.length > 0 && /^## \[/.test(lines[0])) {
    return lines.slice(1).join('\n').trim();
  }
  return section.trim();
}

function runCli() {
  const version = process.argv[2];
  if (!version) {
    process.stderr.write('Usage: node scripts/changelog-section.mjs <version>\n');
    process.exit(2);
  }
  const changelog = readFileSync(`${REPO_ROOT}CHANGELOG.md`, 'utf8');
  const section = extractChangelogSection(changelog, version);
  if (!section) {
    process.stderr.write(`No "## [${version}]" section with content found in CHANGELOG.md.\n`);
    process.exit(1);
  }
  const body = stripHeading(section);
  if (!body) {
    process.stderr.write(`The "## [${version}]" section in CHANGELOG.md has no body beyond its heading.\n`);
    process.exit(1);
  }
  process.stdout.write(`${body}\n`);
  process.exit(0);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  runCli();
}
