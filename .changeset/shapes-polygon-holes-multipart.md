---
'@spatialdata/core': patch
'@spatialdata/layers': patch
---

Polygon shapes now draw holes and every part of a MultiPolygon; previously only the first part's exterior ring was drawn, filled solid. `FlatPolygonGeometry` gains optional `parts` (GeoArrow-style feature → part → ring offsets), and `positions` now holds every ring. A hovered feature's `polygon` is its first part with holes.
