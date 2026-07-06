import { cpSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const rollupExternals = new Set(['zarrita', 'zod', 'anndata.js', 'zarrextra', 'apache-arrow']);

export default defineConfig({
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
