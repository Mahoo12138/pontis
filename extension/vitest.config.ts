import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // @testing-library/react only registers its auto-cleanup when vitest exposes
    // `afterEach` as a global; without it, renders leak into the next test.
    globals: true,
    setupFiles: ['./src/testing/setup.ts'],
    // `.tsx` files opt into jsdom with a per-file `@vitest-environment` block,
    // so the core suite keeps running in plain node.
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
