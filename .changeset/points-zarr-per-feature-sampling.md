---
"spatialdata-js-util": minor
---

`write_points_zarr` takes opt-in `sampling="hybrid"` / `"per-feature"` (with `feature_budget`) so rare features survive to coarse levels, recording each level's fractions in `index/feature_fraction`, and `hash_r` / `id_key` to derive the sample from transcript ids so it doesn't depend on frame chunking. Defaults write the same stores as before. Per-feature levels are marked `random-per-feature`, which points-zarr spec 0.1 does not define.
