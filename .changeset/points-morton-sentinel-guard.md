---
"@spatialdata/core": patch
---

Points: refuse to Morton-tile an artifact whose sentinel bounding box is not the domain
its codes were quantised against.

The sentinel rows are a claim a Parquet artifact makes about itself, and nothing else in
the file forces them to be true. Believing a wrong one does not fail — it silently clips
the tile grid to the bogus box, so whole regions are never even requested, and
`mortonIntervalsForBounds` normalises viewports against it and selects the wrong row
groups. Points are never misplaced (the reader re-filters to the query bounds), so the
only symptom is that part of the map is missing.

`getPointsTilingMetadata` now recomputes `morton_code_2d` from x/y for a sample of real
rows and requires a majority to agree. On a real 12.1M-point element a sound artifact
matches 320/320 sampled rows and one with a stale sentinel box matches 0/320, so the test
is not marginal; a majority rather than an exact match tolerates coordinates landing on a
cell boundary. A rejected element reports `supportsRowGroupRangeReads: false` with no
`bounds` — the same pair the oversized-sentinel case already produced — so it degrades to
the capped preload through the existing path, and warns rather than downgrading silently.

Cost is one extra row-group read per element, cached with the metadata: the probe goes
from 3 range reads / 0.37 MB / 414 ms to 4 / 2.16 MB / 523 ms on that element. The sample
is taken from the middle of the file, because a truncated box can agree with the true one
near the origin by coincidence but never in the interior.

`mortonCode2dForPoint` / `mortonBoundsAgreeWithCodes` are exported for this, and pin the
interleave convention (x in the even bits) that `zcoverRectangle` and the writer both
already assumed without anything checking they stayed in step.
