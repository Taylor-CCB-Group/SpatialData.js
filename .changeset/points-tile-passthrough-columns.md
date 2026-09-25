---
'@spatialdata/core': minor
---

Return extra numeric columns from a tiled points load

`PointsInBoundsOptions.columns` is now honoured on the Morton tiled path, returning each
named column in `PointsInBoundsResponse.columns` — one value per point, in lockstep with
the geometry — so `qv`, `nucleus_distance` and `overlaps_nucleus` are reachable from a
tiled element. Float (including float64), bool, and integers up to 32 bits; a column that
is missing, non-numeric or a 64-bit integer is refused with a warning rather than served
wrong.
