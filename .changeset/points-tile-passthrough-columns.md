---
'@spatialdata/core': minor
---

Return extra numeric columns from a tiled points load

`PointsInBoundsOptions.columns` was never read on the Morton tiled path, so `qv`,
`nucleus_distance` and `overlaps_nucleus` were unreachable from a tiled element — which
blocked the standard Xenium `qv >= 20` filter. Naming them now returns them in
`PointsInBoundsResponse.columns`, one value per point in lockstep with the geometry.
Float, bool and integers up to 32 bits; a column that is missing, non-numeric or 64-bit
is refused with a warning rather than served wrong. Strings are not served yet.
