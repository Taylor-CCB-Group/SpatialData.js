import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// The host serves the View as one HTML document, so everything is inlined.
export default defineConfig(({ mode }) => ({
  plugins: [viteSingleFile()],
  build: {
    sourcemap: mode === 'development' ? 'inline' : false,
    minify: mode !== 'development',
    rollupOptions: { input: 'mcp-app.html' },
    outDir: 'dist',
  },
}));
