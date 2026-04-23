import { defineConfig } from 'vitest/config';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
// not strictly necessary as vite will provide this in config context
// but now I'm looking at it, adding this so there's less hidden magic.
const __dirname = dirname(__filename);

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'tests/**/*.test.ts', // Integration tests (run via test:integration)
      'packages/**/*.spec.ts', // Package unit tests (.spec.ts)
      'packages/**/*.spec.tsx', // Package unit tests for React (.spec.tsx)
    ],
    // Integration tests may need extra time for fixture generation hooks
    hookTimeout: 60000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['packages/**/*.ts'],
      exclude: ['packages/**/*.test.ts', 'packages/**/dist/**'],
    },
  },
  resolve: {
    alias: {
      '@spatialdata/core': resolve(__dirname, 'packages/core/src'),
      '@spatialdata/zarrextra': resolve(__dirname, 'packages/zarrextra/src'),
    },
  },
});
