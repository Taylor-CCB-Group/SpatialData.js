import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import dts from 'vite-plugin-dts';
import path from 'node:path';

interface DefineConfigOptions {
  pkgRoot: string;
  libName: string;
  external?: (string | RegExp)[];
}

export function defineViteConfig(options: DefineConfigOptions) {
  const { pkgRoot, libName, external = [] } = options;

  return defineConfig({
    root: pkgRoot,
    plugins: [
      react(),
      dts({
        // Keep the plugin fully anchored to this package
        root: pkgRoot,
        tsconfigPath: path.resolve(pkgRoot, 'tsconfig.json'),

        // Emit types into dist and make a top-level index.d.ts
        outDir: path.resolve(pkgRoot, 'dist'),
        entryRoot: 'src', // IMPORTANT: relative to root, not absolute
        insertTypesEntry: true,
        strictOutput: true,

        // Don’t rewrite tsconfig "paths" to relative imports
        pathsToAliases: false,

        // Only process source; keep configs/tests out
        include: ['src'],
        exclude: [
          'dist/**',
          'vite.config.ts',
          'vite.config.*.ts',
          '**/*.test.*',
          '**/*.spec.*',
          '**/*.stories.*',
        ],

        // Optional: if you don’t want .d.ts.map files
        // compilerOptions: { declarationMap: false },
      }),
    ],
    build: {
      outDir: path.resolve(pkgRoot, 'dist'),
      lib: {
        entry: path.resolve(pkgRoot, 'src/index.ts'),
        name: libName,
        fileName: () => 'index.js',
        formats: ['es'],
      },
      rollupOptions: {
        external: ['react', 'react-dom', ...external],
      },
    },
  });
}
