import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_NAME = '@warlockcode/agent-viewer';

export interface PackageInfo {
  /** Folder that holds the package.json of Agent Viewer (the repository root, or the installed package). */
  root: string;
  version: string;
}

let cached: PackageInfo | undefined;

/**
 * Finds the package root from this module's folder upwards. Works from the TypeScript sources (`cli/`) and
 * from the bundled CLI (`dist-cli/`), which sit at different depths.
 */
export function packageInfo(): PackageInfo {
  if (cached) return cached;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth++) {
    const candidate = path.join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, 'utf8'));
        if (pkg.name === PACKAGE_NAME) {
          cached = { root: dir, version: typeof pkg.version === 'string' ? pkg.version : '0.0.0' };
          return cached;
        }
      } catch {
        // Not a readable package.json: keep looking upwards.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cached = { root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), version: '0.0.0' };
  return cached;
}

/** Absolute path of the script that runs the CLI: the bundle when installed, the TypeScript entry in a checkout. */
export function cliScriptPath(): string {
  const { root } = packageInfo();
  const bundled = path.join(root, 'dist-cli', 'cli.js');
  const self = fileURLToPath(import.meta.url);
  // Running from the bundle: this module was inlined into dist-cli/, so point at the bundle entry.
  if (self.startsWith(path.join(root, 'dist-cli') + path.sep)) return bundled;
  return path.join(root, 'cli', 'index.ts');
}
