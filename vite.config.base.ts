import path from 'node:path';
import babel from '@rolldown/plugin-babel';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export type WorkspaceAlias = {
  find: string | RegExp;
  replacement: string;
};

export function createWorkspaceSourceAliases(rootDir: string): WorkspaceAlias[] {
  return [
    {
      find: 'zarrextra/workers',
      replacement: path.resolve(rootDir, 'packages/zarrextra/src/workers/index.ts'),
    },
    {
      find: /^zarrextra$/,
      replacement: path.resolve(rootDir, 'packages/zarrextra/src/index.ts'),
    },
    {
      find: '@spatialdata/avivatorish',
      replacement: path.resolve(rootDir, 'packages/avivatorish/src/index.ts'),
    },
    {
      find: '@spatialdata/core',
      replacement: path.resolve(rootDir, 'packages/core/src/index.ts'),
    },
    {
      find: '@spatialdata/layers',
      replacement: path.resolve(rootDir, 'packages/layers/src/index.ts'),
    },
    {
      find: '@spatialdata/react',
      replacement: path.resolve(rootDir, 'packages/react/src/index.ts'),
    },
    {
      find: '@spatialdata/vis',
      replacement: path.resolve(rootDir, 'packages/vis/src/index.ts'),
    },
  ];
}

interface DefineConfigOptions {
  pkgRoot: string;
  libName: string;
  external?: (string | RegExp)[];
  /**
   * Enable the React Compiler (babel-plugin-react-compiler) for this package.
   * Only opt in for packages that ship React components; the plugin must be a
   * dependency of any package that sets this to true.
   */
  reactCompiler?: boolean;
}

export function defineViteConfig(options: DefineConfigOptions) {
  const { pkgRoot, libName, external = [], reactCompiler = false } = options;

  return defineConfig({
    root: pkgRoot,
    plugins: [
      react(),
      ...(reactCompiler ? [babel({ presets: [reactCompilerPreset()] })] : []),
      dts({
        root: pkgRoot,
        tsconfigPath: path.resolve(pkgRoot, 'tsconfig.json'),
        outDir: path.resolve(pkgRoot, 'dist'),
        entryRoot: 'src',
        insertTypesEntry: true,
        strictOutput: true,
        pathsToAliases: false,
        include: ['src'],
        exclude: [
          'dist/**',
          'vite.config.ts',
          'vite.config.*.ts',
          '**/*.test.*',
          '**/*.spec.*',
          '**/*.stories.*',
        ],
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
        external: [
          'react',
          'react-dom',
          'react/jsx-runtime',
          'react/jsx-dev-runtime',
          'react/compiler-runtime',
          ...external,
        ],
      },
    },
  });
}
