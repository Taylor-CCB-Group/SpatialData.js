import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const pkgExternals = ['zarrita', '@fideus-labs/fizarrita', '@fideus-labs/worker-pool'];

// .d.ts files are emitted via `tsc --emitDeclarationOnly` in the build script.
export default defineConfig(({ mode }) => {
  const isCodecWorkerBuild = mode === 'codec-worker';

  return {
    build: {
      // Never empty dist here. `codec-worker.js` is emitted by a separate pass
      // (--mode codec-worker), so a default pass that empties dist would delete it
      // and leave `workers.js`'s `new URL('./codec-worker.js', ...)` dangling —
      // which is exactly what `dev` (vite build --watch) used to do. The `build`
      // script does an explicit `rm -rf dist` instead.
      emptyOutDir: false,
      lib: {
        entry: isCodecWorkerBuild
          ? resolve(__dirname, 'src/workers/codec-worker.ts')
          : {
              index: resolve(__dirname, 'src/index.ts'),
              workers: resolve(__dirname, 'src/workers/index.package.ts'),
            },
        formats: ['es'],
        fileName: isCodecWorkerBuild ? () => 'codec-worker.js' : undefined,
      },
      rollupOptions: {
        external(id) {
          if (isCodecWorkerBuild) {
            return false;
          }
          return pkgExternals.includes(id);
        },
        treeshake: isCodecWorkerBuild ? false : undefined,
        output: {
          codeSplitting: isCodecWorkerBuild ? false : undefined,
          entryFileNames: '[name].js',
        },
      },
      sourcemap: true,
      target: 'es2022',
    },
    test: {
      globals: true,
      environment: 'node',
      include: ['tests/**/*.spec.ts'],
      coverage: {
        provider: 'v8',
        reporter: ['text', 'json', 'html'],
      },
    },
  };
});
