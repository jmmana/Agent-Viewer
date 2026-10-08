import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Vitest runs without globals, so Testing Library cannot register its own cleanup.
afterEach(() => {
  cleanup();
});

// jsdom has no media queries. The office asks for `prefers-reduced-motion`.
Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  writable: true,
  value: (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }),
});

// jsdom has no canvas. Returning null makes the office skip its render loop; the renderer itself is
// tested with a recording context in `tests/lib/canvasRenderer.test.ts`.
HTMLCanvasElement.prototype.getContext = function getContext() {
  return null;
} as unknown as HTMLCanvasElement['getContext'];
