---
"@spatialdata/core": minor
---

Spatial elements report a `no-length-unit` issue for each coordinate system their transform reaches without a length unit (including SpatialData's `"unit"` placeholder), with a `declare-length-unit` remedy. `ElementIssue` now includes it, so describe issues with the new `describeElementIssue` rather than `describeRasterLayoutIssue`. `physicalLengthOfUnit` maps OME-NGFF length names and symbols to a size in SI units.
