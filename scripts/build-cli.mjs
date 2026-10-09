// Builds what the `agent-viewer` command ships in the npm package, into dist-cli/:
//   dist-cli/viewer/  the office, prebuilt, streaming from the server that serves it (same origin)
//   dist-cli/cli.js   the CLI and the ingestion server, bundled for Node. Dependencies (express, zod) stay
//                     external and are installed with the package; Node built-ins stay external too.
// Usage: node scripts/build-cli.mjs [--skip-viewer]
import { chmodSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = fileURLToPath(new URL('../dist-cli', import.meta.url));
const skipViewer = process.argv.includes('--skip-viewer');

if (!skipViewer) {
  rmSync(outDir, { recursive: true, force: true });
  const previous = process.env.VITE_AGENT_VIEWER_API_URL;
  process.env.VITE_AGENT_VIEWER_API_URL = 'same-origin';
  try {
    await build({
      root,
      mode: 'production',
      logLevel: 'warn',
      build: { outDir: `${outDir}/viewer`, emptyOutDir: true },
    });
  } finally {
    if (previous === undefined) delete process.env.VITE_AGENT_VIEWER_API_URL;
    else process.env.VITE_AGENT_VIEWER_API_URL = previous;
  }
}

await build({
  root,
  configFile: false,
  mode: 'production',
  logLevel: 'warn',
  publicDir: false,
  build: {
    ssr: true,
    outDir,
    emptyOutDir: false,
    target: 'node22',
    minify: false,
    sourcemap: false,
    copyPublicDir: false,
    rolldownOptions: {
      input: { cli: fileURLToPath(new URL('../cli/index.ts', import.meta.url)) },
      output: {
        format: 'es',
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        banner: (chunk) => (chunk.isEntry ? '#!/usr/bin/env node' : ''),
      },
    },
  },
});

chmodSync(`${outDir}/cli.js`, 0o755);
console.log('dist-cli/ ready: cli.js and the prebuilt office in dist-cli/viewer/');
