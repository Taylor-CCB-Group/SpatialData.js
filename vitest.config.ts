import { defineConfig } from 'vitest/config';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
// not strictly necessary as vite will provide this in config context
// but now I'm looking at it, adding this so there's less hidden magic.
const __dirname = dirname(__filename);

/**
 * Root test config: one project per workspace package, plus the integration suite.
 *
 * The packages are listed as projects rather than gathered by a root-level
 * `include` glob so that each runs under *its own* `vite.config.ts` — which is
 * where its test environment is declared. One root config cannot serve them all:
 * `react`, `vis` and `avivatorish` render React hooks and need `jsdom`, the rest
 * run in `node`. Flattening them into a single `node` project failed every React
 * hook test with `document is not defined`, and left this command testing
 * something different from `pnpm test`, which has always used the per-package
 * configs.
 *
 * Select with `--project`: `test:unit` takes everything but `integration`,
 * `test:integration` takes only it.
 */
export default defineConfig({
  test: {
    projects: [
      'packages/*',
      {
        test: {
          name: 'integration',
          globals: true,
          environment: 'node',
          include: ['tests/**/*.test.ts'],
          // Integration tests may need extra time for fixture generation hooks
          hookTimeout: 60000,
        },
        resolve: {
          alias: {
            '@spatialdata/core': resolve(__dirname, 'packages/core/src'),
            zarrextra: resolve(__dirname, 'packages/zarrextra/src'),
          },
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['packages/**/*.ts'],
      exclude: ['packages/**/*.test.ts', 'packages/**/dist/**'],
    },
  },
});
