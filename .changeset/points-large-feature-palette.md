---
"@spatialdata/layers": patch
---

Colour-by-feature now works on points elements with more features than the GPU's maximum texture size (e.g. a ~25k-gene whole-transcriptome panel), which previously drew every point uncoloured.
