import { cpSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { createWorkspaceSourceAliases } from '../../vite.config.base';

const rollupExternals = new Set(['zarrita', 'zod', 'anndata.js', 'zarrextra', 'apache-arrow']);

export default defineConfig({
  // Resolve sibling packages to their sources, as `vis` already does.
  //
  // Without this, a test here importing `zarrextra` gets whatever is in that
  // package's `dist` — so editing `packages/zarrextra/src` changes nothing until
  // it is rebuilt, and the suite silently keeps testing the previous build. The
  // failure is invisible: tests pass or fail against stale code with no hint
  // that the source under the cursor is not the source under test.
  //
  // Harmless for `build`: rollup consults `external` with the unresolved
  // specifier, so `zarrextra` is externalized before an alias could apply.
  resolve: {
    alias: createWorkspaceSourceAliases(resolve(__dirname, '../..')),
  },
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        workers: resolve(__dirname, 'src/workers/index.ts'),
        'points-worker': resolve(__dirname, 'src/workers/points-worker.ts'),
      },
      name: 'SpatialDataCore',
      formats: ['es', 'cjs'],
      fileName: (format, entryName) => {
        if (entryName === 'index') {
          return `index.${format === 'es' ? 'js' : 'cjs'}`;
        }
        return `${entryName}.js`;
      },
    },
    rollupOptions: {
      external: (id) => {
        const normalizedId = id.replace(/\\/g, '/');
        if (normalizedId.includes('vendor/parquet-wasm/parquet_wasm.js')) {
          return true;
        }
        return rollupExternals.has(id);
      },
    },
    sourcemap: true,
    target: 'es2020',
  },
  plugins: [
    {
      name: 'externalize-vendored-parquet-wasm',
      resolveId(source) {
        const normalizedSource = source.replace(/\\/g, '/');
        if (normalizedSource.includes('vendor/parquet-wasm/parquet_wasm.js')) {
          return { id: source, external: true };
        }
        return null;
      },
    },
    {
      name: 'copy-vendored-parquet-wasm',
      closeBundle() {
        cpSync(
          resolve(__dirname, 'vendor/parquet-wasm'),
          resolve(__dirname, 'dist/vendor/parquet-wasm'),
          { recursive: true }
        );
      },
    },
  ],
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
