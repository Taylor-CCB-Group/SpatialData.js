---
"@spatialdata/layers": patch
---

Circle radii and `common`-unit polygon stroke widths now scale with the element's transform, so Visium spots in a downscaled coordinate system draw as spots instead of one merged blob.
