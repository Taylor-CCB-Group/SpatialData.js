---
"@spatialdata/core": patch
---

`getTransformationForLevel` now maps a level's `scale`/`translation` onto the multiscale's axes by name, so `(c, y, x)` images no longer get their channel factor applied to x.
