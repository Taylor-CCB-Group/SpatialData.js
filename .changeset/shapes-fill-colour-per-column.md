---
"@spatialdata/core": minor
"@spatialdata/vis": patch
---

Two shapes layers over one element can now colour by different columns; previously they overwrote each other's fill-colour rows and the colours flickered between them. `ShapesResolver.getFillColorRows(key, column)` now takes the column (breaking for callers of the one-argument form).
