---
"@spatialdata/layers": minor
"@spatialdata/vis": minor
---

Experimental WebGPU support: images, labels, shapes and points now render when deck runs on a WebGPU device (`SpatialCanvas` takes `deckProps`, e.g. `{ deviceProps: { type: 'webgpu', adapters: [webgpuAdapter] } }`). deck.gl 9.4 picks the vertically mirrored pixel on WebGPU; the SpatialCanvas viewers correct this, and a Deck of your own needs `applyWebGPUPickingFix(device)` from `onDeviceInitialized`.
