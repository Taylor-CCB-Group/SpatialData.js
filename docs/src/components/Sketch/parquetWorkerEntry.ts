/**
 * Worker entry for the docs site, existing only so webpack bundles core's parquet
 * worker instead of copying it.
 *
 * `new Worker(new URL('@spatialdata/core/parquet-worker', import.meta.url))` does NOT
 * work: webpack resolves the bare specifier to core's published `dist/parquet-worker.js`
 * and emits that file as a static asset, still carrying its relative imports to sibling
 * chunks and a bare `apache-arrow` — 9kB whose every import 404s. Pointing the URL at a
 * *local source file* instead makes webpack treat it as a worker entry and bundle the
 * graph behind it, parquet-wasm included.
 */
import '@spatialdata/core/parquet-worker';
