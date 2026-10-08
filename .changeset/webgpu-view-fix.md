---
"@spatialdata/layers": minor
"@spatialdata/vis": patch
---

Experimental `applyWebGPUViewFix(device)` works around two deck.gl 9.4 bugs on WebGPU: a view smaller than the canvas draws upside down, and a view with `clear: true` (Viv's OverviewView, for one) doesn't draw at all. The SpatialCanvas viewers now apply it with the picking fix. If you build your own Deck, call it from `onDeviceInitialized`.
