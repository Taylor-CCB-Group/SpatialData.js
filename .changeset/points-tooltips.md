---
'@spatialdata/layers': minor
'@spatialdata/vis': minor
---

Hovering a point now shows a tooltip with its feature name and position, on both the preloaded and tiled points paths. `onFeatureHover` / `onFeatureClick` emit the pick as well, so a host rendering its own tooltip gets it too.

`SpatialFeaturePickEvent` gains a `points` member: it has no `rowIndex` (a points element has no associated table), so reading `event.rowIndex` without narrowing on `elementKind` is now a type error.
