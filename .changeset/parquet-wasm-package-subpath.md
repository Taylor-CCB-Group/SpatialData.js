---
"@spatialdata/core": minor
---

Load the vendored parquet-wasm through a package subpath, so it resolves in a
consumer's production build.

`@spatialdata/core/parquet-wasm` is now an export, and the loader imports it by that
name. It used to reach the glue by relative path behind a `/* @vite-ignore */`, and
both halves shipped: the comment told the consumer's bundler to skip resolution, and
`../vendor/parquet-wasm/parquet_wasm.js` stayed in the published chunk. A consumer's
build inlines that chunk into its own `assets/`, where the path means
`{root}/vendor/…` — a file no build emitted. Every production build 404d on the first
parquet read while dev worked, because a dev server serves core's `vendor/` tree out
of node_modules. MDV had to copy that tree into its output (Taylor-CCB-Group/MDV#539);
that workaround can go, along with the identical one in this repo's own
production-browser harness.

The consumer's bundler now resolves the subpath and emits the wasm as a hashed asset —
one copy per bundle, no vendor directory to serve. Deleting the `@vite-ignore` alone
would not have done it: `build.lib` inlines assets regardless of size, so bundling the
glue here turns the 6.6MB wasm into base64 in an 8.8MB chunk, per format.

The published package also drops `dist/vendor/`, its second copy of the wasm.
