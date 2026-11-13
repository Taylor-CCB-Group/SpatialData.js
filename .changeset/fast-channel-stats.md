---
'@spatialdata/avivatorish': patch
---

Channel stats for 8- and 16-bit integer images are now computed from a histogram: the same `domain` and `contrastLimits` as before, about 25x faster, so adding an image layer no longer blocks the main thread for hundreds of milliseconds per channel. The raster returned with `includeRaster` is now in pixel order; Viv's stats used to reorder it in place, which scrambled anything drawn from it.
