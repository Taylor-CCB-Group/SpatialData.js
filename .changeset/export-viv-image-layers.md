---
"@spatialdata/vis": minor
---

New `vivImageLayers(vivLayerProps, { viewId, viewportId, onHover })` builds image layers the way `VivSpatialViewer` does, for a host that builds its own `Deck` (for example a grid with a view per cell). It returns layers keyed by image config id, ready for `renderStackToDeckLayers`' `entryLayers`, and each layer id carries `getVivId(viewId)` for the host's `layerFilter`. A tiled image loads its tiles in whichever view draws it, so one set can be shared by every cell; pass `viewportId` to tie them to one view. `getVivId` and the `VivImageLayerConfig` type are now exported too.
