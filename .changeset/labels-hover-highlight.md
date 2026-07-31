---
'@spatialdata/layers': minor
'@spatialdata/vis': minor
---

Highlight the labels feature under the cursor, the way shapes already do.

Nothing to configure on either canvas surface: the highlight follows the same hover pick
that feeds the tooltip, so it respects `hoverTooltipMode`. Hosts driving `LabelsLayer`
directly get `highlightedLabelId` and an optional `highlightColor`.
