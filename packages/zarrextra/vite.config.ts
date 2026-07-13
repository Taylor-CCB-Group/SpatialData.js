import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const pkgExternals = ['zarrita', '@fideus-labs/fizarrita', '@fideus-labs/worker-pool'];

// .d.ts files are emitted via `tsc --emitDeclarationOnly` in the build script.
export default defineConfig(({ mode }) => {
  const isCodecWorkerBuild = mode === 'codec-worker';

  return {
    build: {
      emptyOutDir: !isCodecWorkerBuild,
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
