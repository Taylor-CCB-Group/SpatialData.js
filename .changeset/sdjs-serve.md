---
'@spatialdata/cli': minor
'sdjs': minor
---

New `sdjs serve [root]` (`npx @spatialdata/cli serve` or `uvx sdjs serve`) serves every `*.zarr` and `*.zarr.zip` store under a directory on loopback and opens them in the bundled viewer, with a picker that greys out stores that are not SpatialData.
