---
"@spatialdata/core": patch
---

Points: fold the two row-group footer walks together, and the two probe memos.

Housekeeping after the memory-accounting work landed on main, no behaviour change.

- `rowGroupFeatureCodeExtents` and `rowGroupMortonExtents` were the same walk twice:
  strip the footer's trailing 8 bytes, parse, flatten across parts, verify the count
  against the dataset. That now lives once as `rowGroupColumnStats` in
  `parquetFooterStats`, which is where the footer format is already understood. The
  decode stays with each caller on purpose — it is the part that depends on knowing
  the column's logical type, and getting it wrong is silent (a `uint32` Morton code
  read signed comes back negative past 2^31).
- The two row-group index probes each hand-rolled "memoize the in-flight promise, but
  forget a `null` or a rejection". They now share one `memoizeProbe`, which evicts
  through the existing `evictIfCurrent` so a retry that already superseded an entry is
  never clobbered by the old promise settling late — the plain-`Map` form of the
  discipline ADR 0005 rung 2b applies to `parquetTableCache`, for values far too small
  to be worth a byte budget.

Pins the half of that memo nothing covered: a failed extent probe must be retried, not
remembered. A single transient read would otherwise leave the bisect treating a
readable row group as unbounded for the life of the source, and the only symptom is
viewport queries quietly returning fewer points.

Also corrects `loadParquetRowGroupColumnExtent`'s doc comment, which still said footer
statistics were out of reach of the vendored parquet-wasm build and named the minimal
Thrift read as the way out. That read exists now, row-group selection goes through it,
and this path is the fallback.
