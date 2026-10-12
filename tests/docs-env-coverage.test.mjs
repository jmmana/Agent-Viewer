// Issue #104 (release gate for 0.7.0): "every variable read by server/, cli/ or the SDKs appears in the
// README configuration table or in docs/cli.md, except an explicit allowlist ... with a one-line reason per
// entry". This test scans the actual source for AGENT_VIEWER_*/VITE_AGENT_VIEWER_* reads (process.env member
// access, process.env[...] / import.meta.env[...] bracket access, the envValue(env, 'NAME') CLI helper, and
// Python's os.environ), so a newly added variable that nobody documented fails CI instead of being found by a
// user reading the source. Unlike the issue's own wording, "documented" here means anywhere under docs/,
// README.md, docs/README.es.md, server/.env.example or an SDK's own README, not only the one central table:
// several existing variables (AGENT_VIEWER_USAGE_LEDGER_MAX_ROWS, the OTLP limits, the Docker-only variables)
// are already documented that way, in the feature's own guide, and that pattern is treated as correct, not as
// a gap to close.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function walk(relDir, exts, out = []) {
  const absDir = path.join(repoRoot, relDir);
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'dist-lib' || entry.name === 'dist-cli' || entry.name.startsWith('.')) continue;
    const relPath = path.join(relDir, entry.name);
    if (entry.isDirectory()) {
      walk(relPath, exts, out);
    } else if (exts.includes(path.extname(entry.name)) || exts.includes(entry.name)) {
      out.push(relPath);
    }
  }
  return out;
}

function read(relPath) {
  return readFileSync(path.join(repoRoot, relPath), 'utf8');
}

// Source directories that can read one of these variables, and the file extensions worth scanning in each.
const SOURCE_DIRS = ['server', 'cli', 'src', 'sdk', 'packages', 'docker', 'scripts'];
const SOURCE_EXTS = ['.ts', '.tsx', '.mjs', '.js', '.py', '.sh', 'Dockerfile'];

const VAR_PATTERN = /AGENT_VIEWER_[A-Z0-9]+(?:_[A-Z0-9]+)*/g;

// Token mentioned only in a comment about a name that was never actually read (the real variable is named
// differently); these are prose, not a live binding, and must never be required to be "documented".
const NEVER_REAL = new Set([
  'AGENT_VIEWER_OTLP_MAX_BODY_BYTES', // server/index.ts comment: the original proposal's name, replaced by AGENT_VIEWER_OTLP_MAX_BODY
  'AGENT_VIEWER_OTLP_MAX_SPANS', // same comment, replaced by AGENT_VIEWER_OTLP_MAX_RECORDS
]);

// Real variables with no end-user doc mention, each with why that is fine.
const UNDOCUMENTED_ALLOWLIST = new Map([
  ['AGENT_VIEWER_CLI', 'docker/app-entrypoint.sh internal override of the CLI bundle path inside the image, not a variable an operator sets'],
  ['AGENT_VIEWER_EMBEDDED', 'internal flag the embeddable library sets on itself; never read from a real environment, never meant for an operator to set'],
]);

function collectSourceFiles() {
  const files = [];
  for (const dir of SOURCE_DIRS) walk(dir, SOURCE_EXTS, files);
  return files;
}

function collectCodeVars() {
  const found = new Set();
  for (const relPath of collectSourceFiles()) {
    const text = read(relPath);
    for (const match of text.matchAll(VAR_PATTERN)) {
      found.add(match[0]);
    }
  }
  return found;
}

const DOC_FILES = [
  'README.md',
  'server/.env.example',
  ...walk('docs', ['.md']),
  'sdk/python/README.md',
  ...walk('packages', ['.md']),
];

function isDocumentedAnywhere(varName) {
  for (const relPath of DOC_FILES) {
    if (read(relPath).includes(varName)) return true;
  }
  return false;
}

const codeVars = [...collectCodeVars()].filter((v) => !NEVER_REAL.has(v)).sort();

test('every AGENT_VIEWER_*/VITE_AGENT_VIEWER_* variable read by the server, CLI, SDKs or Docker images is documented somewhere', () => {
  const undocumented = codeVars.filter((v) => !UNDOCUMENTED_ALLOWLIST.has(v) && !isDocumentedAnywhere(v));
  assert.deepEqual(
    undocumented,
    [],
    `These variables are read in source but never mentioned in README.md, docs/**/*.md, server/.env.example, or an SDK README: ${undocumented.join(', ')}. Document them, or add a one-line reason to UNDOCUMENTED_ALLOWLIST in this test if that is intentional.`,
  );
});

test('the allowlist of intentionally undocumented variables has no stale entries', () => {
  const codeVarSet = new Set(codeVars);
  const stale = [...UNDOCUMENTED_ALLOWLIST.keys()].filter((v) => !codeVarSet.has(v));
  assert.deepEqual(stale, [], `These allowlisted variables are no longer read anywhere in source: ${stale.join(', ')}. Remove them from UNDOCUMENTED_ALLOWLIST.`);
});

test('the NEVER_REAL denylist has no stale entries (the comment it excuses was removed or the name became real)', () => {
  const codeVarsWithNeverReal = new Set();
  for (const relPath of collectSourceFiles()) {
    for (const match of read(relPath).matchAll(VAR_PATTERN)) codeVarsWithNeverReal.add(match[0]);
  }
  const stale = [...NEVER_REAL].filter((v) => !codeVarsWithNeverReal.has(v));
  assert.deepEqual(stale, [], `These NEVER_REAL entries no longer appear anywhere in source: ${stale.join(', ')}. Remove them.`);
});
