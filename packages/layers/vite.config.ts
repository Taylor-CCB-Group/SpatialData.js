import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// .d.ts files are emitted via `tsc --emitDeclarationOnly` in the build script.
export default defineConfig({
  root: resolve(__dirname),
  build: {
    outDir: resolve(__dirname, 'dist'),
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'SpatialDataLayers',
      fileName: () => 'index.js',
      formats: ['es'],
    },
    rollupOptions: {
      external: [
        '@deck.gl/core',
        '@hms-dbmi/viv',
        '@math.gl/core',
        '@spatialdata/core',
        'deck.gl',
        'zod',
      ],
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
  },
});
