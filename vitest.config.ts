import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
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

