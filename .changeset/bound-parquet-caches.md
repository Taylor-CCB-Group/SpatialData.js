---
'@spatialdata/core': minor
---

Bound the two parquet caches on `SpatialDataTableSource` by resident bytes
([ADR 0005](https://github.com/Taylor-CCB-Group/SpatialData.js/blob/main/docs/adr/0005-memory-accounting-before-management.md)
rung 2), and add the `ByteLruCache` they are built on.

`parquetTableBytes` (compressed file bytes) and `parquetTableCache` (decoded
Arrow tables) were plain `Record`s with no eviction of any kind. A source held
**both tiers of every parquet file any caller had ever touched**, simultaneously,
until the source itself was discarded — double memory for zero eviction benefit.
That is a leak, and this fixes it rather than building an architecture around it:
both are now byte-bounded LRUs that report `byteLength`, and memory is
assertable in a test for the first time.

**Breaking for anyone reading those two fields directly.** They are no longer
plain objects: `source.parquetTableBytes[path]` becomes
`source.parquetTableBytes.get(path)`, with `peek` for a read that should not
count as a use, plus `has`, `delete`, `clear`, `size` and `byteLength`. Nothing
in this repository outside `VTableSource` touched either one.

Ceilings default to 128 MB encoded and 256 MB decoded per source, overridable
via the new `parquetCacheLimits` field on `DataSourceParams`. The numbers are
guesses that bound a leak, not a measured working set — the ADR is explicit that
they stay guesses until something measures them, so they are a constructor
option rather than a constant you would have to fork the library to change.

Two semantics worth knowing:

- **A value larger than the whole budget is admitted, not refused**, and left as
  the sole resident. Refusing it would be the worse failure: `loadParquetBytes`
  runs roughly twenty times per points load, so a file that can never be admitted
  becomes twenty refetches of the file that was already too big to fetch once.
- **Entries are inserted before their size is known.** The decoded cache holds
  the in-flight promise — that is what dedupes concurrent callers onto one WASM
  decode — so it is sized at zero until the table lands, then recounted. Arrow's
  `Data.byteLength` walks the whole child tree, so it is asked exactly once per
  table and the total is maintained incrementally from there.
