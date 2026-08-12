---
"@spatialdata/core": patch
---

Points (Morton): fix viewport queries silently dropping row groups — the holes in the
tiled render.

`readParquetRowGroupColumnExtent` built the bisect index by reading a row group's
first value and its last value, taking the last with
`readParquetRowGroup(..., { offset: rowCount - 1, limit: 1 })`. The vendored
parquet-wasm **ignores `offset` on a row-group read** and returned the first row
again, so every row group reported `max === min` — claiming to span a single value.

Nothing errored. The bisect asks "first row group whose max >= target", and an
understated max moves that answer one group too far forward, so the row group that
actually *contained* the interval start was never read. On a real 12.1M-point Xenium
artifact one viewport query silently lost **11 of the 92 matching row groups —
187,990 points (6%)**, which is what the Z-order-shaped holes in the tiled points
render were.

The upper bound now comes from the sort order instead: the file is sorted on this
column, so a row group's values all lie at or below the next row group's first value.
That is conservative (equal codes spanning a boundary keep both groups in range),
needs only the one read that works, and halves the reads — each row group's first
value is cached and shared with its neighbour. The last row group keeps an open
bound.

The regression test asserts an exact point count for a bounded query rather than
"more than zero": this class of bug is silent by construction, and only a total sees
it.
