import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vite';
import { createWorkspaceSourceAliases, defineViteConfig } from '../../vite.config.base';

const pkgRoot = fileURLToPath(new URL('.', import.meta.url));
const workspaceRoot = path.resolve(pkgRoot, '../..');

const baseConfig = defineViteConfig({
  pkgRoot,
  libName: 'SpatialDataReact',
  external: ['@spatialdata/core'],
  reactCompiler: true,
});

export default mergeConfig(baseConfig, {
  // Sibling packages resolve to their sources — see the note in
  // `packages/core/vite.config.ts` for why the default is a trap for tests.
  // Nothing here imports a sibling in a test yet; this is so the first one that
  // does is not the one that has to discover it.
  resolve: {
    alias: createWorkspaceSourceAliases(workspaceRoot),
  },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['tests/**/*.spec.ts*'],
  },
});
