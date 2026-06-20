import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

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
      external: ['zarrita', 'zod', 'anndata.js', 'parquet-wasm', 'zarrextra', 'apache-arrow'],
    },
    sourcemap: true,
    target: 'es2020',
  },
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
