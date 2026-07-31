import { cpSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { createWorkspaceSourceAliases } from '../../vite.config.base';

const rollupExternals = ['zarrita', 'zod', 'anndata.js', 'zarrextra', 'apache-arrow'];

/**
 * Left for the consumer to resolve — the package itself, and any subpath of it.
 *
 * Equivalent to the `/^name(?:\/.*)?$/` form the other packages pass as regexes,
 * spelled as a predicate because this config externalizes by function. Matching
 * the exact specifier alone would leave a subpath entry point — `zarrextra/workers`,
 * `zod/v4` — to be resolved and bundled, and with the workspace source aliases
 * above, resolving `zarrextra/workers` means inlining a sibling's source.
 *
 * `apache-arrow/vector` is imported here already, but only as a type, so it is
 * erased before rollup sees it. The first value import of a subpath would not be.
 */
const isExternalPackage = (id: string) =>
  rollupExternals.some((name) => id === name || id.startsWith(`${name}/`));

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
        return isExternalPackage(id);
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
