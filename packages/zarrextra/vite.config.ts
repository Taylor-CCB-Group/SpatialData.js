import { resolve } from 'node:path';
import dts from 'vite-plugin-dts';
import { defineConfig } from 'vitest/config';

const pkgExternals = ['zarrita', '@fideus-labs/fizarrita', '@fideus-labs/worker-pool'];

export default defineConfig(({ mode }) => {
  const isCodecWorkerBuild = mode === 'codec-worker';

  return {
    plugins: [
      !isCodecWorkerBuild &&
        dts({
          outDir: 'dist',
          include: ['src'],
          exclude: [
            '**/*.test.ts',
            'src/workers/codec-worker.ts',
            'src/workers/codec-worker-init.ts',
          ],
        }),
    ],
    build: {
      emptyOutDir: !isCodecWorkerBuild,
      lib: {
        entry: isCodecWorkerBuild
          ? resolve(__dirname, 'src/workers/codec-worker.ts')
          : {
              index: resolve(__dirname, 'src/index.ts'),
              workers: resolve(__dirname, 'src/workers/index.ts'),
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
