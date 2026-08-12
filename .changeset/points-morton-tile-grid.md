---
"@spatialdata/core": patch
"@spatialdata/layers": patch
---

Points: select Morton row groups from footer statistics, and size the tile grid from the
artifact (D5 step 6).

**Row-group selection no longer reads the file.** `selectMortonRowGroups` picks row
groups from the per-row-group `[min, max]` the tiling probe already parsed out of the
parquet footer. The bisect it replaces range-read the row group's BYTES — every column,
~2MB on a real transcripts artifact — to recover two boundary values, `log2(rowGroups)`
steps per Morton interval, for a few hundred intervals per query. Measured on one
1024 um viewport tile of a 12.1M-point element, both returning the same 643,961 points:

| row-group selection | range reads | bytes | wall |
|---|---|---|---|
| bisect | 97 | 175.12 MB | 2911 ms |
| footer index | 32 | 57.83 MB | 1035 ms |

The remaining 32 reads are the row-group data itself. The new path is also stricter: the
bisect tested only `max` and assumed row groups tile the code space without gaps, while
this intersects both ends. The bisect stays as the fallback when statistics will not
parse, so this is an optimisation rather than a new requirement.

**The tile grid is derived instead of hardcoded.** It was one fixed level
(`minZoom/maxZoom: -1`), so every tile was 1024 local units at every zoom: zooming in
read a 1024-unit tile to look at 50 units of it, and 1024 came from deck's defaults
rather than from the data. `mortonTileGrid` now derives both ends from the point
density: the finest level stays at least one row group's footprint (below that, four
tiles fetch what one used to, for the same bytes and more requests), the coarsest holds
at most 400k rows, and `zoomOffset = log2(modelMatrixScale)` couples deck's `z` — chosen
from a world-space zoom — to tile spans expressed in local units.

For the Xenium element that is two levels, 1024 um and 512 um, and the narrowness is the
point: the row-group size is the floor, so 50k-row groups put it at ~402 um. The old
fixed 1024 was accidentally near-optimal for that file and would not be for one an order
of magnitude smaller or denser.

**The tile cache is budgeted in rows.** `maxCacheSize` comes from a row budget rather
than deck's default of `5 x the selected tile count`, which on a coarse viewport of this
element could retain ~220 tiles / ~71M rows against a 4M resident cap. It is now 16 tiles
/ ~5.2M rows, stated. `maxRequests` stays at 6, but as a decision rather than an
inheritance. Accounting only — nothing evicts by bytes yet (ADR 0005).

`PointsLoaderCapabilities` gains `totalRows` and `maxRowsPerGroup`, which is what the
grid is derived from.
