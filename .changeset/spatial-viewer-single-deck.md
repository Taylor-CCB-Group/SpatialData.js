---
"@spatialdata/vis": patch
---

The canvas no longer remounts its Deck when image layers are added, removed or hidden, so the GPU device, layers and fetched tiles survive and `onDeviceInitialized` fires once. `deckProps.controller: false` now disables pan and zoom.
