---
"@spatialdata/layers": patch
---

Isolated groups now keep their offscreen targets across canvases with deck's experimental `_canvases`. Cells of different sizes no longer reallocate and redraw their targets every frame, and a canvas no longer misses a contents change because a canvas drawn before it doesn't show the group.
