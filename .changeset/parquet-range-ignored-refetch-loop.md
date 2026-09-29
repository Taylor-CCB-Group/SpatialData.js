---
'@spatialdata/core': patch
---

Load points from a server that ignores HTTP Range

Such a server answers the footer probe with the whole file, which parsed as a nonsense
footer length: the element never loaded and re-requested forever. It now falls back to
whole-file reads. A failed points resource also stops re-planning on every reconcile —
`PointsResolver.retry(key)` is the way back.
