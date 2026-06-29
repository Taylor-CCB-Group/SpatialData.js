---
"@spatialdata/layers": patch
---

Fix multiscale labels rendering with an obviously wrong (vertically stretched, mis-placed) transformation when zoomed out past the coarsest resolution level.

The `MultiscaleLabelsTileLayer` was configured with `minZoom: -20`, so deck.gl kept subdividing the tile grid below the deepest available resolution level. Past that level `getTileData` clamps to the deepest loader and returns the same data, but the tile bbox keeps doubling — so the bounds formula stretched that fixed data across an ever-larger world rect, far beyond the image extent. `minZoom` is now capped at `-(loader.length - 1)`, matching Viv's `MultiscaleImageLayer`, so the coarsest real tiles stay correctly placed at any zoom-out.

Also adds the bbox-culling guards Viv's `renderSubLayers` applies (skip tiles with negative bbox edges or zero-sized data) for defense in depth. This is the underlying cause that #44 only masked by making sublayer ids unique.
