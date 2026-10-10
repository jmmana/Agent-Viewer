/**
 * Library privacy guard (issue #79): the embeddable `@warlockcode/agent-viewer` component (`src/lib/**`) must
 * never reach the Model Ops ledger client or the Model Ops tab components, and must never reference the usage
 * ledger endpoints directly. Model Ops is demo-app-only: `src/App.tsx` and `src/components/**`, never `src/lib`.
 *
 * Walks the real import graph from `src/lib/index.ts` (relative imports only; a bare specifier is a published
 * package, never part of this walk) instead of grepping the whole repo, so a legitimate mention of "usage
 * ledger" in a comment elsewhere never produces a false positive, and a new `src/lib` entry point is covered
 * automatically as soon as `index.ts` imports it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = path.resolve(__dirname, '../../src');
const LIB_ENTRY = path.resolve(SRC_ROOT, 'lib/index.ts');

const IMPORT_PATTERN = /(?:import|export)\s[^;]*?from\s+['"](\.[^'"]+)['"]/g;

function resolveImport(fromFile: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function walkImportGraph(entry: string): Set<string> {
  const visited = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      const resolved = resolveImport(file, match[1]);
      if (resolved && !visited.has(resolved)) stack.push(resolved);
    }
  }
  return visited;
}

describe('src/lib never reaches the Model Ops ledger client or components (issue #79)', () => {
  const graph = walkImportGraph(LIB_ENTRY);

  it('walked more than just the entry point, so the guard below is meaningful', () => {
    expect(graph.size).toBeGreaterThan(1);
  });

  it('never imports src/integrations/ledgerClient', () => {
    const offenders = [...graph].filter((file) => file.endsWith('integrations/ledgerClient.ts'));
    expect(offenders).toEqual([]);
  });

  it('never imports anything under src/components/modelOps', () => {
    const offenders = [...graph].filter((file) => file.includes(`${path.sep}components${path.sep}modelOps${path.sep}`));
    expect(offenders).toEqual([]);
  });

  it('no file in the graph contains a literal usage-ledger endpoint path', () => {
    const offenders: string[] = [];
    for (const file of graph) {
      const source = fs.readFileSync(file, 'utf8');
      if (source.includes('/api/v1/usage')) offenders.push(path.relative(SRC_ROOT, file));
    }
    expect(offenders).toEqual([]);
  });
});
