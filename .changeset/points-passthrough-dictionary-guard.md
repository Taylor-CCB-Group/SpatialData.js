---
'@spatialdata/core': patch
---

Refuse a passthrough column that sits after a dictionary column

`readParquetRowGroup` silently mis-decodes every field at or after the first arrow
dictionary-typed one, handing back type defaults with `nullCount === 0` and nothing
thrown. Such a column is now rejected (`after-dictionary`) rather than served wrong.
Nothing served today crosses that boundary; see
[docs/parquet-wasm-limitations.md](../docs/parquet-wasm-limitations.md).
