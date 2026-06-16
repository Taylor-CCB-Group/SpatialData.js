import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createWorkspaceSourceAliases } from '../../vite.config.base';
import { fixtureServerOrigin } from '../../scripts/fixture-server-port.mjs';

// https://vitejs.dev/config/
const workspaceRoot = path.resolve(__dirname, '../..');
const require = createRequire(import.meta.url);
const reactRoot = path.dirname(require.resolve('react/package.json'));
const reactDomRoot = path.dirname(require.resolve('react-dom/package.json'));

export default defineConfig({
  root: path.resolve(__dirname, 'demo'),
  plugins: [react()],
  resolve: {
    alias: [
      ...createWorkspaceSourceAliases(workspaceRoot),
      { find: 'react', replacement: reactRoot },
      { find: 'react-dom', replacement: reactDomRoot },
    ],
    dedupe: ['react', 'react-dom'],
  },
  worker: {
    format: 'es',
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    open: false,
    proxy: {
      '/test-fixtures': {
        target: fixtureServerOrigin(),
        changeOrigin: true,
      },
    },
  },
});
