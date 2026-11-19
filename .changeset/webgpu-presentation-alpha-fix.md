---
"@spatialdata/layers": minor
---

New `applyWebGPUPresentationAlphaFix(device)`: with deck's experimental `_canvases` on WebGPU, each canvas is opaque, so empty or translucent parts of a view show black instead of the page behind. Call it from Deck's `onDeviceInitialized`, alongside `applyWebGPUViewFix`, to make them transparent as a single deck canvas is.
