import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
  root: resolve(__dirname),
  plugins: [
    dts({
      root: resolve(__dirname),
      tsconfigPath: resolve(__dirname, 'tsconfig.json'),
      outDir: resolve(__dirname, 'dist'),
      entryRoot: 'src',
      insertTypesEntry: true,
      strictOutput: true,
      pathsToAliases: false,
      include: ['src'],
      exclude: ['dist/**', 'vite.config.ts', '**/*.spec.ts'],
    }),
  ],
  build: {
    outDir: resolve(__dirname, 'dist'),
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'SpatialDataLayers',
      fileName: () => 'index.js',
      formats: ['es'],
    },
    rollupOptions: {
      external: ['deck.gl', 'zod'],
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
  },
});
