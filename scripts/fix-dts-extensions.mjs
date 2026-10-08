// Adds explicit `.js` extensions to relative imports in the emitted declaration files, so the types also
// resolve under `moduleResolution: node16/nodenext` and not only in bundlers.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? 'dist-lib');
const specifier = /((?:import|export)\s[^'"]*?from\s*|import\(\s*)(['"])(\.{1,2}\/[^'"]+)\2/g;

function resolveSpecifier(file, spec) {
  if (/\.(js|mjs|cjs|json|css)$/.test(spec)) return spec;
  const base = path.resolve(path.dirname(file), spec);
  if (fs.existsSync(`${base}.d.ts`)) return `${spec}.js`;
  if (fs.existsSync(path.join(base, 'index.d.ts'))) return `${spec}/index.js`;
  throw new Error(`Cannot resolve ${spec} from ${path.relative(root, file)}`);
}

let changed = 0;
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.d.ts')) {
      const source = fs.readFileSync(full, 'utf8');
      const next = source.replace(specifier, (_match, prefix, quote, spec) => `${prefix}${quote}${resolveSpecifier(full, spec)}${quote}`);
      if (next !== source) {
        fs.writeFileSync(full, next);
        changed++;
      }
    }
  }
}

walk(root);
console.log(`fix-dts-extensions: updated ${changed} declaration files in ${path.relative(process.cwd(), root)}`);
