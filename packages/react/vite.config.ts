import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vite';
import { defineViteConfig } from '../../vite.config.base';

const pkgRoot = fileURLToPath(new URL('.', import.meta.url));

const baseConfig = defineViteConfig({
  pkgRoot,
  libName: 'SpatialDataReact',
  external: ['@spatialdata/core'],
  reactCompiler: true,
});

export default mergeConfig(baseConfig, {
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['tests/**/*.spec.ts*'],
  },
});
