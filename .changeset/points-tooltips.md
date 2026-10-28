---
'@spatialdata/layers': minor
'@spatialdata/vis': minor
---

Hovering a point now shows a tooltip with its feature name and position, on both the preloaded and tiled points paths. `onFeatureHover` / `onFeatureClick` emit the pick as well, so a host rendering its own tooltip gets it too.

A points layer's per-row feature codes are now loaded whichever way `colorByFeature` is set, so the tooltip names the feature on a layer that is not coloured by it. For that to not turn colour on, `colorByFeature: false` now reaches the layer as a prop instead of being implied by withheld codes — a layer that asked for no colour-by-feature got it anyway when its codes were loaded for the filter, and now stays flat.

`SpatialFeaturePickEvent` gains a `points` member: it has no `rowIndex` (a points element has no associated table), so reading `event.rowIndex` without narrowing on `elementKind` is now a type error.
