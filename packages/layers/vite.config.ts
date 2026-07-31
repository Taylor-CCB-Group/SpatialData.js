import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { createWorkspaceSourceAliases } from '../../vite.config.base';

// .d.ts files are emitted via `tsc --emitDeclarationOnly` in the build script.
export default defineConfig({
  root: resolve(__dirname),
  // Sibling packages resolve to their sources — see the note in
  // `packages/core/vite.config.ts` for why the default is a trap for tests.
  resolve: {
    alias: createWorkspaceSourceAliases(resolve(__dirname, '../..')),
  },
  build: {
    outDir: resolve(__dirname, 'dist'),
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'SpatialDataLayers',
      fileName: () => 'index.js',
      formats: ['es'],
    },
    rollupOptions: {
      // Whole families, by regex, rather than the handful of specifiers this
      // package happens to import today.
      //
      // deck.gl, Viv and this package must share ONE luma.gl runtime. The list
      // named `@deck.gl/core` but no luma at all, so `@luma.gl/core`, `/engine`
      // and `/shadertools` came in through the layers that build their own `Model`
      // and were bundled into `dist/index.js`: a consumer that also loads deck.gl
      // then had two `ShaderAssembler` classes — and `ShaderAssembler.getDefault…()`
      // is a static, so "the default assembler" then means different objects to
      // deck and to Viv. Viv's `VivShaderAssembler` copies deck's registered
      // modules and hooks off that default, so it can copy from an assembler deck
      // never touched and lose `DECKGL_FILTER_GL_POSITION` entirely.
      //
      // Mirrors `packages/vis`, which has externalized both families all along.
      external: [
        /^@deck\.gl\/.+$/,
        /^@luma\.gl\/.+$/,
        /^@math\.gl\/.+$/,
        /^@probe\.gl\/.+$/,
        /^@spatialdata\/[^/]+$/,
        /^@vivjs\/.+$/,
        '@hms-dbmi/viv',
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
