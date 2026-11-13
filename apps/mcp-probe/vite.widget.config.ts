import { defineConfig } from 'vite';

// anywidget loads one ES module from a string, so everything is inlined into dist/widget.js.
export default defineConfig({
  build: {
    lib: { entry: 'src/widget.ts', formats: ['es'], fileName: () => 'widget.js' },
    outDir: 'dist',
    emptyOutDir: false,
    minify: false,
  },
});
