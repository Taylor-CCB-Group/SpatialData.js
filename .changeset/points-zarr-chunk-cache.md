---
"@spatialdata/core": patch
---

Experimental: the tiles of a points-zarr element share a cache of the decoded chunks they read (up to `POINTS_ZARR_CACHE_BYTES`, 256 MB per element), so neighbouring tiles no longer fetch the same chunks and returning to a view reads nothing. With the codec workers enabled, points chunks are now decoded off the main thread. On a 1.19B-transcript section a view reads half the bytes.
