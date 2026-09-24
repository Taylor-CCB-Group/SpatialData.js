---
'@spatialdata/core': minor
---

Return extra numeric columns from a tiled points load

`PointsInBoundsOptions.columns` existed but was never read on the Morton tiled path,
which projected a fixed set — `x, y, z?, morton_code_2d, {feature_key}_codes` — and
discarded the rest. `qv`, `nucleus_distance` and `overlaps_nucleus` were therefore
unreachable from a tiled element, which blocked both the standard Xenium `qv >= 20`
filter and any intracellular/extracellular work.

They were never the expensive part. parquet-wasm cannot fetch an individual column
chunk ([limitations](../docs/parquet-wasm-limitations.md)), so this path range-reads
**whole row groups, every column**. And `{ columns }` turns out to be inert in the
vendored build — there is no projected decode either, so these columns were already
being fetched *and* decoded, then discarded. Naming them in `columns` now returns them
in `PointsInBoundsResponse.columns`, one value per point, in lockstep with the
geometry. The added cost is materialising each one into a buffer and transferring it;
no extra bandwidth, and no extra decode.

Float, bool and integers up to 32 bits, carried in a `Float64Array` — the one lane
that represents all of them exactly, where a `Float32Array` would quietly round an
Int32 above 2^24. A requested column that is missing, non-numeric, or 64-bit is
**refused with a warning** rather than served wrong: `transcript_id` cannot survive
the lane, and a string column such as `cell_id` would otherwise have come back as a
correctly-sized, correctly-aligned array of `NaN`. A string column wants codes plus a
catalog, the shape `featureCodes` already uses; that is not built yet.

Bool and Float16 are decoded through `get()` rather than the `toArray()` fast path:
both are stored as typed arrays that pass an `ArrayBuffer.isView` check, so the fast
path would return `NaN` for every Bool and raw bit patterns for every Float16 — a
Float16 `1` arriving as `15360`.

Values are re-read from each row group as it is scanned. They are deliberately not
cached alongside the accumulating buffer: a tile spanning two row groups would
otherwise pair the second group's points with the first group's values, one value per
point, which no length check can detect.

Works on both the worker and main-thread branches of the tiled load.
