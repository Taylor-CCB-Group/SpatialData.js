import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { createWorkspaceSourceAliases } from '../../vite.config.base';

/**
 * Every runtime dependency this package declares — all of them `dependencies`,
 * so a consumer installs them transitively and needs to do nothing.
 *
 * The list is the whole set on purpose. Externalizing some and bundling others
 * is the arrangement that produces two copies of a library in one application:
 * `@math.gl/core` in particular is also a direct dependency of `layers` and
 * `vis`, and `Matrix4` instances have to survive being passed between them.
 *
 * `ol` is only ever reached as `ol/format/WKB.js` — a subpath, and so external
 * only by way of the matching below.
 */
const rollupExternals = [
  'zarrita',
  'zod',
  'anndata.js',
  'zarrextra',
  'apache-arrow',
  '@math.gl/core',
  'earcut',
  'ol',
];

/**
 * Left for the consumer to resolve — the package itself, and any subpath of it.
 *
 * Equivalent to the `/^name(?:\/.*)?$/` form the other packages pass as regexes,
 * spelled as a predicate because this config externalizes by function. Matching
 * the exact specifier alone would leave a subpath entry point — `zarrextra/workers`,
 * `zod/v4` — to be resolved and bundled, and with the workspace source aliases
 * above, resolving `zarrextra/workers` means inlining a sibling's source.
 *
 * `apache-arrow/vector` is imported here already, but only as a type, so it is
 * erased before rollup sees it. The first value import of a subpath would not be.
 */
/**
 * The vendored parquet-wasm glue, as the package subpath a consumer resolves.
 *
 * External on purpose: `build.lib` inlines every asset regardless of
 * `assetsInlineLimit`, so bundling the glue turns its 6.6MB wasm into base64 in an
 * 8.8MB chunk, per format. Left external, the consumer's bundler resolves it through
 * our `exports` map and emits the wasm properly. See `src/parquetWasmLoader.ts`.
 */
const VENDORED_PARQUET_WASM = '@spatialdata/core/parquet-wasm';

const isExternalPackage = (id: string) =>
  rollupExternals.some((name) => id === name || id.startsWith(`${name}/`));

export default defineConfig({
  // Resolve sibling packages to their sources, as `vis` already does.
  //
  // Without this, a test here importing `zarrextra` gets whatever is in that
  // package's `dist` — so editing `packages/zarrextra/src` changes nothing until
  // it is rebuilt, and the suite silently keeps testing the previous build. The
  // failure is invisible: tests pass or fail against stale code with no hint
  // that the source under the cursor is not the source under test.
  //
  // Harmless for `build`: rollup consults `external` with the unresolved
  // specifier, so `zarrextra` is externalized before an alias could apply.
  resolve: {
    alias: createWorkspaceSourceAliases(resolve(__dirname, '../..')),
  },
  // NOTE: the cjs pass warns EMPTY_IMPORT_META twice, and that is expected. It
  // replaces `import.meta` with `{}`, which both call sites now rely on: each reads
  // `import.meta.url` into a variable and checks it, so `undefined` there means "no
  // module URL in this build" rather than a crash. Rolldown's suggested
  // `transform.define` suppression is not reachable through Vite's config in v8 —
  // passing it here changes nothing — so the warning stays until it is.
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        workers: resolve(__dirname, 'src/workers/index.ts'),
        'parquet-worker': resolve(__dirname, 'src/workers/parquet-worker.ts'),
      },
      name: 'SpatialDataCore',
      formats: ['es', 'cjs'],
      // EVERY entry must name its format, not just `index`. Both passes write to the
      // same directory, so a name that ignores `format` is claimed twice and the cjs
      // pass silently overwrites the es one — leaving a CommonJS file under a `.js`
      // extension in a `"type": "module"` package, which nothing can load. That is how
      // `parquet-worker.js` shipped: `new Worker(url, { type: 'module' })` died on
      // `require is not defined`, so no consumer could ever start the parquet worker,
      // and the feature-index scan (its only caller with no main-thread fallback) was
      // unreachable outside this repo. See `tests/distEntryFormats.spec.ts`.
      fileName: (format, entryName) => `${entryName}.${format === 'es' ? 'js' : 'cjs'}`,
    },
    rollupOptions: {
      external: (id) => id === VENDORED_PARQUET_WASM || isExternalPackage(id),
    },
    sourcemap: true,
    target: 'es2020',
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
});
