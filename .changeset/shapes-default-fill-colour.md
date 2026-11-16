---
'@spatialdata/layers': patch
---

Changing a polygon shapes layer's default fill colour no longer re-resolves every feature's colour, hidden and faded state. At 140k shapes a colour-picker step drops from about 70ms of main-thread work to under 3ms.
