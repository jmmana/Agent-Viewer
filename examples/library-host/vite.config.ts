import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * Standalone dev server for the library-host example (issue #260). Not part of the root build or its scripts:
 * run with `npx vite --config examples/library-host/vite.config.ts`. `/api` is forwarded, server side, to the
 * small `node:http` proxy in `proxy.ts` (its own process, started separately; see README.md), so the browser
 * never talks to the Agent Viewer server directly and never holds its token.
 */
const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  plugins: [react()],
  server: {
    port: 5180,
    proxy: {
      '/api': {
        target: process.env.LIBRARY_HOST_PROXY_URL ?? 'http://127.0.0.1:8788',
        changeOrigin: false,
      },
    },
  },
});
