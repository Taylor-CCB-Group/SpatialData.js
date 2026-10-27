---
"spatialdata-js-util": minor
---

`ensure_pyramids(sdata)` gives the raster elements of an in-memory `SpatialData` the overview levels they lack, without writing or recompressing anything, so a caller about to `sdata.write()` pays for no extra copies.

Behaviour change: `add_pyramids`, `images add-pyramid` and `recompress_spatialdata(pyramid=True)` now rebuild any element whose coarsest level is larger than `min_size` (or, with an explicit level count, that has fewer levels than asked for), instead of skipping every element with more than one level. A shallow pyramid is rebuilt from full resolution, so its existing overviews are recomputed. Pass `force` to rebuild regardless, as before. Skipped elements report a new `reason`.
