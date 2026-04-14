import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createWorkspaceSourceAliases } from '../../vite.config.base';

// https://vitejs.dev/config/
const workspaceRoot = path.resolve(__dirname, '../..');
const require = createRequire(import.meta.url);
const reactRoot = path.dirname(require.resolve('react/package.json'));
const reactDomRoot = path.dirname(require.resolve('react-dom/package.json'));

export default defineConfig({
  root: path.resolve(__dirname, 'demo'),
  plugins: [react()],
  resolve: {
    alias: {
      ...createWorkspaceSourceAliases(workspaceRoot),
      react: reactRoot,
      'react-dom': reactDomRoot,
    },
    dedupe: ['react', 'react-dom'],
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    open: false,
  },
});
