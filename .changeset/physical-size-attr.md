---
"spatialdata-js-util": minor
"@spatialdata/vis": minor
---

New `spatialdata-js-util physical-size STORE` (also `record_physical_size` and a TUI entry) records how long one unit of each coordinate system is, as the root attribute proposed in scverse/spatialdata-io#441: `"physical_size": {"global": {"size": 0.2125, "unit": "micrometer"}}`. The size comes from `--size CS=SIZE`, or for xenium and atera stores from the scale of their points and shapes (`--assume-reader xenium` for stores written before spatialdata-io 0.7.0), or from atera's `pixel_size`. Only root attributes change. `SpatialCanvas` reads the attribute for its scale bar, after the `coordinateSystemUnit` prop and axis units and before the reader convention.
