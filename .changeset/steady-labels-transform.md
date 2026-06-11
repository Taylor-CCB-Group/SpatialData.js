---
"@spatialdata/layers": patch
---

Fix intermittent labels layer transform glitches when multiple multiscale labels layers are rendered together by making generated bitmask tile layer ids unique per tile resolution.
