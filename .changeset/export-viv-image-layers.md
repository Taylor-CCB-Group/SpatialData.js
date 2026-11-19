---
"@spatialdata/vis": minor
---

New `vivImageLayers(vivLayerProps, { viewId, onHover })` builds image layers the way `VivSpatialViewer` does, for a host that builds its own `Deck` (for example a grid with a view per cell). It returns layers keyed by image config id, ready for `renderStackToDeckLayers`' `entryLayers`, and each layer id carries `getVivId(viewId)` for the host's `layerFilter`. `getVivId` and the `VivImageLayerConfig` type are now exported too.
