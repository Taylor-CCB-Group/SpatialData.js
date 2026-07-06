# Vendored parquet-wasm (browser ESM build)


Copied from the Vitessce CDN build:

- `https://cdn.vitessce.io/parquet-wasm@2c23652/esm/parquet_wasm.js`
- `https://cdn.vitessce.io/parquet-wasm@2c23652/esm/parquet_wasm_bg.wasm`

This build includes row-group APIs (`readMetadata`, `readParquetRowGroup`) that are
not present in the published `parquet-wasm@0.6.1` npm package.

https://github.com/kylebarron/parquet-wasm/issues/804

Loaded by `packages/core/src/parquetWasmLoader.ts`.

Upstream: [kylebarron/parquet-wasm](https://github.com/kylebarron/parquet-wasm)
(MIT OR Apache-2.0).
