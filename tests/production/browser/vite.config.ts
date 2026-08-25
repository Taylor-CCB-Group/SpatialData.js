import { createRequire } from 'node:module';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const testRoot = path.resolve(import.meta.dirname);
const workspaceRoot = path.resolve(testRoot, '../../..');
const require = createRequire(import.meta.url);
const layersRequire = createRequire(path.join(workspaceRoot, 'packages/layers/package.json'));
const reactRoot = path.dirname(require.resolve('react/package.json'));
const reactDomRoot = path.dirname(require.resolve('react-dom/package.json'));
// The ESM entry, deliberately: `require.resolve` yields `dist/index.cjs`, and
// aliasing every `@deck.gl/core` import to it splits `@luma.gl/shadertools` into a
// CJS copy (reached through deck) and an ESM copy (reached through
// `@vivjs/extensions`). Two copies means two `ShaderAssembler` singletons, and
// Viv's own assembler is built by COPYING the default one's modules and hooks at
// construction — so it copies an empty one, and every Viv-derived layer (labels
// included) fails to compile its vertex shader for want of `project`/`layer` and
// deck's `DECKGL_FILTER_*` hooks.
//
// The same single-luma-runtime requirement that `packages/layers`' build externals
// exist to satisfy — this is the consumer-side half of it. Put the `.cjs` back and
// `labels-color-by.spec.ts` fails; that scenario is what catches it.
const deckCoreRoot = layersRequire.resolve('@deck.gl/core').replace(/index\.cjs$/, 'index.js');
const distRoot = (workspacePackage: string) => path.join(workspaceRoot, workspacePackage, 'dist');
const packageRootAliases = (packageName: string, root: string) => [
  { find: new RegExp(`^${packageName}$`), replacement: path.join(root, 'index.js') },
  { find: new RegExp(`^${packageName}/(.+)$`), replacement: path.join(root, '$1') },
];
const fixtureProxy = {
  target: 'http://127.0.0.1:38473',
  changeOrigin: true,
  // VTableSource probes a partitioned fallback after the canonical single-file
  // GeoParquet path. The blobs fixture is deliberately single-file, so serve that
  // same canonical file for the fallback probe too.
  rewrite: (requestPath: string) =>
    requestPath.endsWith('/shapes.parquet/part.0.parquet')
      ? requestPath.replace('/shapes.parquet/part.0.parquet', '/shapes.parquet')
      : requestPath,
};

export default defineConfig({
  root: testRoot,
  plugins: [react()],
  build: {
    // The consumer has one entry point. Keeping it in one chunk avoids a current
    // Rolldown cross-chunk panic in apache-arrow's WHATWG iterator re-export.
    rolldownOptions: { output: { codeSplitting: false } },
  },
  resolve: {
    // Deliberately resolve package entry points to dist, rather than workspace
    // source: this is a consumer-artifact smoke test.
    alias: [
      {
        find: 'zarrextra/workers',
        replacement: path.join(workspaceRoot, 'packages/zarrextra/dist/workers.js'),
      },
      ...packageRootAliases('zarrextra', distRoot('packages/zarrextra')),
      ...packageRootAliases('@spatialdata/avivatorish', distRoot('packages/avivatorish')),
      // Stands in for core's `exports` map, which this harness bypasses by aliasing
      // straight at `dist`. The parquet-wasm glue is the one export not published
      // from there. Before the generic entry, which is prefix-matched.
      {
        find: '@spatialdata/core/parquet-wasm',
        replacement: path.join(workspaceRoot, 'packages/core/vendor/parquet-wasm/parquet_wasm.js'),
      },
      ...packageRootAliases('@spatialdata/core', distRoot('packages/core')),
      ...packageRootAliases('@spatialdata/layers', distRoot('packages/layers')),
      { find: '@deck.gl/core', replacement: deckCoreRoot },
      { find: 'react', replacement: reactRoot },
      { find: 'react-dom', replacement: reactDomRoot },
    ],
    dedupe: ['react', 'react-dom'],
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
    proxy: { '/test-fixtures': fixtureProxy },
  },
  server: { proxy: { '/test-fixtures': fixtureProxy } },
});
