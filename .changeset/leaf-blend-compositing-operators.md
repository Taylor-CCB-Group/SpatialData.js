---
"@spatialdata/core": minor
"@spatialdata/layers": minor
"@spatialdata/vis": minor
---

Render Stack leaf `blendMode` is now drawn for members of isolated groups (outside one it is still saved but not drawn). New blend modes `intersect`, `cut-out`, `xor` and `clip` make a layer act as a mask on what is beneath it in its group, for example to show where two segmentations overlap or disagree.
