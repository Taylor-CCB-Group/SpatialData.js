---
'@spatialdata/vis': patch
---

Keep the last-good fill colours while a `fillColorByColumn` column's rows are loading.

A selected column with no rows yet was treated as "no colours": the projection wrote
`fillColorByFeatureId: {}`, so features dropped to the flat fill (shapes) or channel
colour (labels) for the whole load window. Labels blinked on every column *switch* —
`LabelsResolver` caches rows per element+column, so a switch always has a frame with
no rows.

Not-ready is now a loading state. The entry getters keep serving the previous entry
(same element only — label ids collide across elements), and the feature-state merges
leave the caller's `featureState` alone when there is no entry at all instead of
clearing it. The stale entry's identity still drives the rebuild, so the real colours
appear as soon as the rows settle; a failed load keeps the last good colours and
surfaces through the resolver's notices as before.
