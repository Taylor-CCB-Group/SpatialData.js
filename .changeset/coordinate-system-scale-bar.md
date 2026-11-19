---
"@spatialdata/vis": minor
---

`SpatialCanvas` and `SpatialCanvasViewer` draw a scale bar measured in the selected coordinate system, with or without an image layer. The length of one unit comes from the new `coordinateSystemUnit` prop (`'micrometer'`, or a size such as `{ size: 0.2125, unit: 'µm' }`), then the elements' axis units, then, for stores from spatialdata-io's `xenium` and `atera` readers, the µm scale of their points and shapes. Without any of these there is no bar. An image loader's `physicalSizes` no longer drives the bar. `SpatialViewer` and `VivSpatialViewer` take the resolved `scaleBar`, and `resolveScaleBarSize` is exported for hosts building their own `Deck`.
