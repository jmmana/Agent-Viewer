import { defineConfig } from 'vitest/config';

/**
 * Unit tests for the embeddable library (`src/lib` and the modules it depends on).
 * The older node:test suites in `tests/*.test.mjs` keep running with `npm test`; vitest only picks up
 * `tests/lib`.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['tests/lib/**/*.test.{ts,tsx}'],
    setupFiles: ['tests/setup/vitest.setup.ts'],
    restoreMocks: true,
  },
});
