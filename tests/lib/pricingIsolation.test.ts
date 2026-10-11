/**
 * Library privacy guard (issue #83): prices live only on the server. The embeddable
 * `@warlockcode/agent-viewer` component (`src/lib/**`) must never receive, store or apply a price, so its
 * import graph must never reach the pricing contract, the server-side pricing store, or the bundled starter
 * table. Walks the real import graph from `src/lib/index.ts` (relative imports only), mirroring
 * `libraryIsolation.test.ts` (issue #79).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = path.resolve(__dirname, '../../src');
const REPO_ROOT = path.resolve(__dirname, '../..');
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

describe('src/lib never reaches pricing code or data (issue #83)', () => {
  const graph = walkImportGraph(LIB_ENTRY);

  it('walked more than just the entry point, so the guard below is meaningful', () => {
    expect(graph.size).toBeGreaterThan(1);
  });

  it('never imports src/integrations/pricingContract', () => {
    const offenders = [...graph].filter((file) => file.endsWith('integrations/pricingContract.ts'));
    expect(offenders).toEqual([]);
  });

  it('never imports anything under server/pricing', () => {
    const offenders = [...graph].filter((file) => file.includes(`${path.sep}server${path.sep}pricing${path.sep}`));
    expect(offenders).toEqual([]);
  });

  it('no file in the graph references the starter pricing table path', () => {
    const offenders: string[] = [];
    for (const file of graph) {
      const source = fs.readFileSync(file, 'utf8');
      if (source.includes('pricing/starter.json')) offenders.push(path.relative(SRC_ROOT, file));
    }
    expect(offenders).toEqual([]);
  });

  it('src/integrations/pricingContract.ts is not re-exported from src/lib/index.ts', () => {
    const libIndex = fs.readFileSync(LIB_ENTRY, 'utf8');
    expect(libIndex.includes('pricingContract')).toBe(false);
  });

  it('server/pricing/starter.json exists and is not under src/ (so it is never part of the lib or demo bundle by accident)', () => {
    const starterPath = path.join(REPO_ROOT, 'server', 'pricing', 'starter.json');
    expect(fs.existsSync(starterPath)).toBe(true);
  });
});
