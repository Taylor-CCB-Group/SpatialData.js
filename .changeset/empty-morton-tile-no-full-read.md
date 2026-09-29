---
"@spatialdata/core": patch
---

Load empty points tiles without reading the whole file

A viewport tile with no points in it, common at a tissue edge, fell back to loading the entire points element. `loadPointsInBounds` now returns an empty result for it.
