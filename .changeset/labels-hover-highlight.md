---
'@spatialdata/layers': minor
'@spatialdata/vis': minor
---

Highlight the labels feature under the cursor, the way shapes already do.

`LabelsLayer` takes `highlightedLabelId` (and an optional `labelHighlightColor`), and
`SpatialCanvasViewer` drives it from the same hover pick that feeds the tooltip. Deck's
`autoHighlight` cannot do this job: a labels tile's picking colour covers the whole quad,
so there is no per-label deck object to highlight and turning it on would light up the
entire tile. The highlight is resolved per FRAGMENT instead, comparing the sampled
instance id against a uniform.

A uniform, specifically, so that a pointer move costs no upload. Baking the hovered label
into the colour lookup table would re-send a texture that is megabytes for a large
segmentation on every pointer move — the anti-pattern the whole labels design exists to
avoid. On the vis side the hovered label is runtime render state on a ref plus a version
counter (`setHoveredLabel`), never Render Stack config, mirroring how points already carry
their hover highlight.

The tint prop is `labelHighlightColor`, not `highlightColor`: the latter belongs to deck's
own `Layer`, which defaults it to navy `[0, 0, 128, 128]` and feeds it to `autoHighlight`.
A prop of that name is never absent, so the labels default could never apply.
