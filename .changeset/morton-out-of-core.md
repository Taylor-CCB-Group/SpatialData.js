---
"spatialdata-js-util": minor
---

`points morton-from-zarr` (`run_morton_points_from_zarr`) now sorts points too large for memory out of core instead of loading the whole table, so a billion-row transcripts element no longer needs tens of GB of RAM. It switches over above `--memory-budget` (default 4G) and spills to `--temp-dir` (default: beside the output); the file written is the same either way. Commands that copy a store to a destination now refuse a destination that contains the source, instead of deleting it.

`tables to-csc` (`convert_store_tables_to_csc`) likewise converts a CSR matrix too large for `memory_budget` (default 4 GiB) out of core, spilling beside the table, instead of holding both layouts in memory.

Image recompression keeps only a few chunks per worker in memory, instead of reading each whole resolution level before writing any of it.

`points add-zarr` no longer loads every level-0 point of a band group to build a coarse level: on a 1.2-billion-point element the last levels needed over 15 GB.
