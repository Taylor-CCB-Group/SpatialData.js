import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vite';
import { createWorkspaceSourceAliases, defineViteConfig } from '../../vite.config.base';

const pkgRoot = fileURLToPath(new URL('.', import.meta.url));
const workspaceRoot = path.resolve(pkgRoot, '../..');

const baseConfig = defineViteConfig({
  pkgRoot,
  libName: 'SpatialDataVis',
  external: [/^@spatialdata\/[^/]+$/, /^zustand(?:\/.*)?$/],
});

export default mergeConfig(baseConfig, {
  resolve: {
    alias: createWorkspaceSourceAliases(workspaceRoot),
  },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['tests/**/*.spec.ts*'],
  },
});
