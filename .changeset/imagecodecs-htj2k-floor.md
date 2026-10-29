---
"spatialdata-js-util": patch
---

Require `imagecodecs>=2026.6.26`, the first release with HTJ2K in its wheels for every platform. With an older `imagecodecs` kept by a lockfile, HTJ2K encoding silently needed Node.js; falling back to the Node-based encoder now also emits a `RuntimeWarning`.
