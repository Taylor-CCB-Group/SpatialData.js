---
"@spatialdata/layers": patch
---

Shapes and labels layers no longer sort and serialise their `hiddenFeatureIds`, `fadedFeatureIds` and per-feature colour records on every render to check their caches, which made panning slow with several large filtered layers. Feature-state values are now compared by identity, then by content, so replace them rather than editing them in place.
