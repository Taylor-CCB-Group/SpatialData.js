import { fileURLToPath } from 'node:url';
import { defineViteConfig } from '../../vite.config.base';
import { mergeConfig } from 'vite';

const pkgRoot = fileURLToPath(new URL('.', import.meta.url));

const baseConfig = defineViteConfig({
  pkgRoot,
  libName: 'SpatialDataAvivatorish',
  external: ['@hms-dbmi/viv', '@math.gl/core', 'geotiff', 'zustand'],
});

export default mergeConfig(baseConfig, {
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
  },
});
