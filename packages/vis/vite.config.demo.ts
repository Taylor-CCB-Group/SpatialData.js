import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// https://vitejs.dev/config/
export default defineConfig({
  root: path.resolve(__dirname, 'demo'),
  plugins: [react()],
  resolve: {
    alias: {
      '@spatialdata/vis': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    open: true,
  },
});
