import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: '@spatialdata/cli', environment: 'node', include: ['tests/**/*.test.ts'] },
});
