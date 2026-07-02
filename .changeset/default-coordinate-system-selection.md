---
"@spatialdata/vis": patch
---

Auto-select the coordinate system when a SpatialData object has exactly one. Previously the picker started unselected (showing "Select a coordinate system") even when there was only one choice, and a separate effect would eagerly pick the first of several. Now selection defaults only in the unambiguous single-coordinate-system case; multi-system datasets still require an explicit choice.
