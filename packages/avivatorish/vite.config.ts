import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vite';
import { createWorkspaceSourceAliases, defineViteConfig } from '../../vite.config.base';

const pkgRoot = fileURLToPath(new URL('.', import.meta.url));
const workspaceRoot = path.resolve(pkgRoot, '../..');

const baseConfig = defineViteConfig({
  pkgRoot,
  libName: 'SpatialDataAvivatorish',
  external: [
    '@hms-dbmi/viv',
    '@math.gl/core',
    'zarrita',
    // Subpaths too (`zarrextra/workers`): a string entry matches the exact
    // specifier only, which would leave a subpath import to be resolved — and
    // the workspace source alias below would then inline it into the bundle.
    /^zarrextra(?:\/.*)?$/,
    /^zustand(?:\/.*)?$/,
  ],
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
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
  },
});
