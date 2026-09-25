---
'@spatialdata/core': patch
---

Refuse a passthrough column that sits after a dictionary column

`readParquetRowGroup` silently mis-decodes every field at or after the first arrow
dictionary-typed one, so such a column is now rejected (`after-dictionary`) rather than
served as plausible-looking garbage. Nothing served today crosses that boundary; details
in [docs/parquet-wasm-limitations.md](../docs/parquet-wasm-limitations.md).
