import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vite';
import { defineViteConfig } from '../../vite.config.base';

const pkgRoot = fileURLToPath(new URL('.', import.meta.url));
const coreSrcIndex = path.resolve(pkgRoot, '../core/src/index.ts');

const baseConfig = defineViteConfig({
  pkgRoot,
  libName: 'SpatialDataVis',
  external: ['@spatialdata/core', '@spatialdata/react'],
});

const testResolve =
  process.env.VITEST !== undefined
    ? {
        resolve: {
          alias: {
            // Vitest: resolve workspace `core` from source so exports match TS without a prior build.
            '@spatialdata/core': coreSrcIndex,
          },
        },
      }
    : {};

export default mergeConfig(baseConfig, {
  ...testResolve,
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['tests/**/*.spec.ts*'],
  },
});
