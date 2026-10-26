---
"@spatialdata/core": patch
---

Experimental: points-zarr chunks are read through zarrextra's codec workers when they are enabled, decoded off the main thread, and each element keeps the decoded chunks its tiles read (up to `POINTS_ZARR_CACHE_BYTES`, 256 MB), so neighbouring tiles no longer fetch the same chunks and returning to a view reads nothing. On a 1.19B-transcript section a view reads half the bytes.
