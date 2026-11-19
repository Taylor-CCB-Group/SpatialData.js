---
"@spatialdata/vis": minor
---

`SpatialCanvas` and `SpatialCanvasViewer` draw a scale bar measured in the selected coordinate system's unit, read from the elements' transforms (e.g. `micrometer`), with or without an image layer. There is no bar when the unit is SpatialData's `"unit"` placeholder or elements disagree, unless the new `coordinateSystemUnit` prop declares one (it overrides the metadata). An image loader's `physicalSizes` no longer drives the bar. `SpatialViewer` and `VivSpatialViewer` take the resolved `scaleBar` (`ScaleBarSize`), and `resolveScaleBarSize` is exported for hosts building their own `Deck`.
