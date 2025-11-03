import { fileURLToPath } from 'node:url';
import { defineViteConfig } from '../../vite.config.base';

const pkgRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineViteConfig({
  pkgRoot,
  libName: 'SpatialDataReact',
  external: ['@spatialdata/core'],
});
