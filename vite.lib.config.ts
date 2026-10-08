import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * Library build: the embeddable office as ES modules in `dist-lib/`.
 * React, lucide-react and zod stay external, and every source module keeps its own file so host bundlers
 * can drop what they do not import (for example the zod validators when only `<AgentOffice>` is used).
 */
export default defineConfig({
  plugins: [react()],
  publicDir: false,
  build: {
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
  },
});
