---
"@spatialdata/vis": minor
---

`SpatialCanvas` takes `keepLayersOnSourceChange`: the layers survive a change of `SpatialDataProvider` source, so a store with the same element names opens with the same view. A layer whose element the new store lacks stays in the list, marked unavailable, and draws again when you switch to a store that has it. With it on, changing the coordinate system no longer clears the layers either.
