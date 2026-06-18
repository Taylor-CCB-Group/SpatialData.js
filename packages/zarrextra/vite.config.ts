import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import dts from 'vite-plugin-dts';

const pkgExternals = ['zarrita', '@fideus-labs/fizarrita', '@fideus-labs/worker-pool'];

export default defineConfig({
  plugins: [
    dts({
      outDir: 'dist',
      include: ['src'],
      exclude: ['**/*.test.ts', 'src/workers/codec-worker.ts'],
    }),
  ],
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        workers: resolve(__dirname, 'src/workers/index.ts'),
        'codec-worker': resolve(__dirname, 'src/workers/codec-worker.ts'),
      },
      formats: ['es'],
    },
    rollupOptions: {
      external(id, parentId) {
        if (parentId?.includes('codec-worker')) {
          return false;
        }
        if (parentId?.includes('workers')) {
          return pkgExternals.includes(id);
        }
        return id === 'zarrita';
      },
      output: {
        entryFileNames: '[name].js',
      },
    },
    sourcemap: true,
    target: 'es2022',
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
