---
"@spatialdata/layers": patch
---

`applyWebGPUPickingFix` now also covers `_canvases` canvases that deck creates before `onDeviceInitialized` (those passed when the Deck is constructed), whose picks on WebGPU read the vertically mirrored point.
