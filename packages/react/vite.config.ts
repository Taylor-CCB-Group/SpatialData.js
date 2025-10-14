import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react(), dts({ rollupTypes: true })],
  build: {
    lib: {
      entry: resolve(__dirname, './src/index.ts'),
      name: 'SpatialDataReact',
      fileName: () => 'index.js',
      formats: ['es']
    },
    rollupOptions: {
      external: ['react', 'react-dom', '@spatialdata/core']
    }
  }
});
