import { defineConfig } from 'vite';

// One self-contained file for a host's local-command connector: no node_modules, and no
// reliance on Node's TypeScript stripping. It reads the View from ../mcp-app.html.
export default defineConfig({
  ssr: { noExternal: true, target: 'node' },
  build: {
    ssr: 'main.ts',
    outDir: 'dist/server',
    emptyOutDir: false,
    target: 'node20',
    minify: false,
    rollupOptions: { output: { entryFileNames: 'main.mjs', format: 'es' } },
  },
});
