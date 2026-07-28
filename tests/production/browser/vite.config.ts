import { cpSync } from 'node:fs';
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
const deckCoreRoot = layersRequire.resolve('@deck.gl/core');
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
const coreVendorDir = path.join(workspaceRoot, 'packages/core/dist/vendor');

export default defineConfig({
  root: testRoot,
  plugins: [
    react(),
    {
      name: 'copy-core-parquet-wasm',
      writeBundle() {
        // `@spatialdata/core` publishes this vendored dynamic-import asset. Vite
        // cannot discover the intentionally @vite-ignore import, so a consumer
        // application must make it available at the URL used by the built module.
        cpSync(coreVendorDir, path.join(testRoot, 'dist/vendor'), { recursive: true });
      },
    },
  ],
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
