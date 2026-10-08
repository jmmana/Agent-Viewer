/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig, type BuildEnvironmentOptions } from 'vite';

/**
 * One configuration for the three builds of the repository:
 * - `vite` and `vite build`: the demo app, written to `dist/`.
 * - `vite build --mode lib`: the embeddable library, written to `dist-lib/`. React, lucide-react and zod stay
 *   external, and every source module keeps its own file so host bundlers can drop what they do not import
 *   (for example the zod validators when only `<AgentOffice>` is used).
 * - `vitest`: unit tests of the library in jsdom (`tests/lib`). The node:test suites in `tests/*.test.mjs`
 *   run separately with `npm run test:node`.
 */
const libraryBuild: BuildEnvironmentOptions = {
  outDir: 'dist-lib',
  emptyOutDir: true,
  sourcemap: true,
  minify: false,
  target: 'es2022',
  lib: {
    entry: fileURLToPath(new URL('./src/lib/index.ts', import.meta.url)),
    formats: ['es'],
  },
  rolldownOptions: {
    external: [/^react($|\/)/, /^react-dom($|\/)/, /^lucide-react($|\/)/, /^zod($|\/)/],
    output: {
      preserveModules: true,
      preserveModulesRoot: 'src',
      entryFileNames: '[name].js',
    },
  },
};

export default defineConfig(({ mode }) => {
  const library = mode === 'lib';
  return {
    base: process.env.GITHUB_PAGES === 'true' || process.env.VITE_BASE_PATH
      ? (process.env.VITE_BASE_PATH || '/Agent-Viewer/')
      : '/',
    plugins: library ? [react()] : [react(), tailwindcss()],
    publicDir: library ? false : 'public',
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('.', import.meta.url)),
      },
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
    build: library ? libraryBuild : undefined,
    test: {
      environment: 'jsdom',
      include: ['tests/lib/**/*.test.{ts,tsx}'],
      setupFiles: ['tests/setup/vitest.setup.ts'],
      restoreMocks: true,
    },
  };
});
