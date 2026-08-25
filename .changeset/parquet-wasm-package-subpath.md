---
"@spatialdata/core": patch
---

Load the vendored parquet-wasm through a package subpath, so it resolves in a
consumer's production build.

`@spatialdata/core/parquet-wasm` is now an export, and the loader imports it by that
name. It used to reach the glue by relative path behind a `/* @vite-ignore */`, and
both halves of that shipped: the comment told the consumer's bundler to skip
resolution, and `../vendor/parquet-wasm/parquet_wasm.js` stayed in the published
chunk. A consumer's build inlines that chunk into its own `assets/`, where the path
means `{root}/vendor/…` — a file no build emitted. So every production build 404d on
the first parquet read (shapes, points, tables) while dev worked, because a dev server
serves core's `vendor/` tree straight out of node_modules. MDV had to copy the tree
into its output to compensate (Taylor-CCB-Group/MDV#539); that workaround, and the
identical one in this repo's own production-browser harness, can now be removed.

Resolving the subpath is the consumer bundler's job, so Vite, webpack and rollup all
follow the glue's `new URL('parquet_wasm_bg.wasm', import.meta.url)` and emit the wasm
as a hashed asset alongside the app's other assets — one copy per bundle, no vendor
directory to serve. Note that deleting the `@vite-ignore` alone would not have been
enough here: `build.lib` inlines every asset regardless of `assetsInlineLimit`, so
bundling the glue into this package turns the 6.6 MB wasm into a base64 data URI in an
8.8 MB chunk, once per output format. The specifier stays external for that reason.

The published package also drops its second copy of the wasm: `dist/vendor/` existed
only to satisfy the relative path, and is no longer written.
