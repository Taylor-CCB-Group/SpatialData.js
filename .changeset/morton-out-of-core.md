---
"spatialdata-js-util": minor
---

Billion-row stores now convert in bounded memory. `points morton-from-zarr` and `tables to-csc` work out of core above `--memory-budget` (default 4G) and write the same result as before; the Morton sort spills to `--temp-dir` (default: beside the output), the CSC conversion beside the table. Image recompression and `points add-zarr` no longer load whole levels at once. Commands that copy a store refuse a destination containing the source instead of deleting it.
