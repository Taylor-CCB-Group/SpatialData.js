---
'@spatialdata/layers': patch
---

Depend on `@luma.gl/core` directly, so GPU resource types come from the library rather
than being restated locally. `LabelsLayer` now types its LUT texture as luma's `Texture`;
the package already depends on `@luma.gl/engine` and cannot realistically be used without
luma core.
