---
"spatialdata-js-util": minor
---

`ensure_pyramids(sdata)` gives the raster elements of an in-memory `SpatialData` the overview levels they lack, without writing or recompressing anything, so a caller about to `sdata.write()` pays for no extra copies.

Behaviour change: `add_pyramids`, `images add-pyramid` and `recompress_spatialdata(pyramid=True)` now give levels to any element whose coarsest level is larger than `min_size` (or, with an explicit level count, that has fewer levels than asked for), instead of skipping every element with more than one level. A shallow pyramid keeps its existing levels and gains new ones coarsened from its coarsest level; such elements report `action: "extended"`. `force` still rebuilds every element from full resolution. Skipped elements report a new `reason`.
