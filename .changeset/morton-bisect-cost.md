---
"@spatialdata/core": patch
---

Points (Morton): stop the row-group bisect from doing orders of magnitude more work
than the query needs.

Two independent costs, both measured against a real 12.1M-point Xenium `transcripts`
artifact (245 row groups) with a viewport-sized query rectangle:

- **`zcoverRectangle` now stops at `MORTON_ZCOVER_MAX_DEPTH` (10).** It recursed to
  the full 16 bits per axis, resolving the rectangle to individual quantised cells
  when its only job is picking row groups — **38,014 intervals**, each driving two
  bisects, to select 92 row groups. At the cap that is 521 intervals selecting the
  **same 92 row groups**, verified over a viewport tile, the whole slide and a
  zoomed-in box. A coarser cell can only widen the covered code range, and the rows
  it brings in are filtered against the exact bounds after the read, so the cover
  stays complete.
- **Concurrent extent probes for the same row group are deduped.** The cache held the
  settled value, so it dedups nothing while a read is in flight — and the index is
  built under exactly that load, with every viewport tile bisecting over the same row
  groups at once. Each tile started its own full row-group fetch for an entry the
  others were already fetching (8 concurrent callers: 18 range reads, now 4). A
  failed probe is evicted rather than cached, so a transient error does not strand
  the bisect permanently.

Not fixed, and now documented where it bites: the extent probe should read the row
group's **column statistics**, which are already in the footer we parse, instead of
range-reading and decoding the row group's bytes twice. The vendored parquet-wasm
build exposes no statistics accessor (`RowGroupMetaData` offers only `numRows` /
`fileOffset` / `compressedSize` / `column`), so this needs a wasm rebuild or a minimal
Thrift read of the footer.
