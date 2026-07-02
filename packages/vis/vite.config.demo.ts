import { createRequire } from 'node:module';
import path from 'node:path';
import babel from '@rolldown/plugin-babel';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { fixtureServerOrigin } from '../../scripts/fixture-server-port.mjs';
import { createWorkspaceSourceAliases } from '../../vite.config.base';

// https://vitejs.dev/config/
const workspaceRoot = path.resolve(__dirname, '../..');
const require = createRequire(import.meta.url);
const reactRoot = path.dirname(require.resolve('react/package.json'));
const reactDomRoot = path.dirname(require.resolve('react-dom/package.json'));

export default defineConfig({
  root: path.resolve(__dirname, 'demo'),
  plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
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
  assetsInclude: ['**/*.wasm'],
  server: {
    host: '127.0.0.1',
    // Prefer 5173 but fall back to the next free port when it's taken (e.g. another
    // dev server is already running). Honours the PORT env var when set, so a
    // launcher can pin the port. `strictPort` stays off so the fallback can happen.
    port: Number(process.env.PORT) || 5173,
    strictPort: false,
    open: false,
    proxy: {
      '/test-fixtures': {
        target: fixtureServerOrigin(),
        changeOrigin: true,
      },
    },
  },
});
