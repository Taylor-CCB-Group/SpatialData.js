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
**whole row groups, every column**, and projection happens later at decode time. The
bytes for these columns are already on the wire and were simply being thrown away.
Naming them in `columns` now returns them in `PointsInBoundsResponse.columns`, one
value per point, in lockstep with the geometry — a decode and transfer cost only, and
no extra bandwidth.

Numeric 32-bit columns only. A requested column that is missing, non-numeric, or
64-bit is **refused with a warning** rather than served wrong: `transcript_id` does
not survive a `Float32Array`, and a string column such as `cell_id` would otherwise
have come back as a correctly-sized, correctly-aligned array of `NaN`. A string
column wants codes plus a catalog, the shape `featureCodes` already uses; that is not
built yet.

Works on both the worker and main-thread branches of the tiled load.
