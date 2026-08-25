import path from 'node:path';
import babel from '@rolldown/plugin-babel';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

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
    // Before the bare `@spatialdata/core` entry: alias matching is first-wins and
    // prefix-based, so that entry would otherwise rewrite this subpath to
    // `packages/core/src/index.ts/parquet-wasm`. Same ordering trick as
    // `zarrextra/workers` above.
    //
    // Not a source alias — the vendored parquet-wasm glue. Published consumers reach
    // it through core's `exports` map; in-repo consumers bundle core from source, so
    // they need the same subpath to land on the same file.
    {
      find: '@spatialdata/core/parquet-wasm',
      replacement: path.resolve(rootDir, 'packages/core/vendor/parquet-wasm/parquet_wasm.js'),
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
    // Declaration files (.d.ts) are emitted separately via `tsc --emitDeclarationOnly`
    // in each package's build script — see packages/*/package.json. TypeScript 7's
    // native compiler no longer exposes the JS API that vite-plugin-dts relies on.
    plugins: [
      react(),
      ...(reactCompiler ? [babel({ presets: [reactCompilerPreset()] })] : []),
    ],
    build: {
      outDir: path.resolve(pkgRoot, 'dist'),
      // Published so a consumer's stack trace names our source, not `Le` at
      // `.vite/deps/@spatialdata_layers.js:396`. An embedding application debugs
      // against the built artifact — it is the only form of this code it has.
      sourcemap: true,
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
