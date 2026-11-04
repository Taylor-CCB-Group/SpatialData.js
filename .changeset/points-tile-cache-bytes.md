---
"@spatialdata/core": minor
"@spatialdata/layers": patch
---

Tiled points layers now bound their tile cache by the bytes the tiles hold (`PointsTileGrid.maxCacheByteSize`, the row budget at `POINTS_TILE_ROW_BYTES`), with `maxCacheSize` only a 128-tile backstop. The cache used to hold 16 tiles, so zooming back over levels already visited refetched and rebuilt them.
