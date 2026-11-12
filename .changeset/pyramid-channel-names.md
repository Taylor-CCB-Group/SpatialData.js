---
"spatialdata-js-util": patch
---

Adding pyramid levels keeps the image's channel names. New levels were numbered `0, 1, …`, so an image with named channels came out with mismatched levels that SpatialData refused to write.
