---
"@spatialdata/core": patch
---

Points (Morton): fix viewport queries silently dropping row groups, refuse to tile an
artifact that only looks Morton-ordered, and stop the row-group search doing orders of
magnitude more work than the query needs.

Everything here is measured against a real 12.1M-point Xenium `transcripts` artifact
(245 row groups) with a viewport-sized query rectangle.

**Row groups were silently dropped — the holes in the tiled render.**
`readParquetRowGroupColumnExtent` took a row group's last value with
`readParquetRowGroup(..., { offset: rowCount - 1, limit: 1 })`, and the vendored
parquet-wasm **ignores `offset` on a row-group read**: it returned the first row again, so
every row group reported `max === min`. Nothing errored. The bisect asks "first row group
whose max >= target", and an understated max moves that answer one group too far forward,
so the row group that actually *contained* the interval start was never read — one
viewport query lost **11 of the 92 matching row groups, 187,990 points (6%)**. The upper
bound now comes from the sort order instead: a row group's values all lie at or below the
next row group's first value. That is conservative, needs only the read that works, and
halves the reads. The regression test asserts an exact point count rather than "more than
zero"; this class of bug is silent by construction, and only a total sees it.

**Row-group selection no longer reads the file at all.** `selectMortonRowGroups` picks
from the per-row-group `[min, max]` the tiling probe parses out of the parquet footer. The
bisect it replaces range-read the row group's BYTES — every column, ~2MB — to recover two
boundary values, `log2(rowGroups)` steps per Morton interval. On one 1024 um viewport
tile, both returning the same 643,961 points:

| row-group selection | range reads | bytes | wall |
|---|---|---|---|
| bisect | 97 | 175.12 MB | 2911 ms |
| footer index | 32 | 57.83 MB | 1035 ms |

The remaining 32 reads are the row-group data itself. The footer path is also stricter:
the bisect tested only `max` and assumed row groups tile the code space without gaps,
while this intersects both ends. The bisect stays as the fallback when statistics will not
parse, so this is an optimisation rather than a new requirement.

**Two guards, because a file can carry the column and still not be Morton-ordered.**

- *The sentinel box must be the domain the codes were quantised against.* Those rows are
  a claim the artifact makes about itself, and nothing in the file forces it to be true.
  Believing a wrong one does not fail — it clips the tile grid to the bogus box, so whole
  regions are never requested. `getPointsTilingMetadata` now recomputes `morton_code_2d`
  from x/y for a sample of real rows and requires a majority to agree: a sound artifact
  matches 320/320 sampled rows and one with a stale sentinel box matches 0/320, so the
  test is not marginal. The sample comes from the middle of the file, because a truncated
  box can agree with the true one near the origin by coincidence but never in the interior.
- *The column must actually ascend.* A feature-primary artifact — sorted
  `(feature, morton)` — carries the identical column with identical, correct values, a
  correct sentinel box, and every field the probe looks for. Only the order is wrong, and
  nothing in the file said so, so the bisect landed arbitrarily and a tile came back
  holding whichever feature blocks lived in the row groups it picked: some tiles showed
  one or two genes, most showed none. The probe now requires the per-row-group `[min, max]`
  to be non-decreasing. On the permutations store,
  `transcripts_feature_then_morton` descends at 185 of its 244 boundaries while both
  morton-primary elements descend at none — including `transcripts_morton_then_feature`,
  so a *secondary* feature key stays supported and the test is on the file rather than on
  the element's name.

Both gates fail CLOSED, which takes a third state: an extents list that is empty (no
footer, a parse failure, a row-group count that disagreed) or entirely null (the column
carries no statistics) is `'unverified'`, not `'sorted'` — see `mortonRowGroupOrderVerdict`.
Reading either as sorted would pass a feature-primary artifact through the one gate that
exists to stop it, and an all-null index is worse still, because every unknown extent is
included and so every tile scans the whole file. An extent that is not a range at all
(non-finite, or `min > max`) is rejected for the same reason: it cannot come from healthy
statistics, so it means the decode is wrong.

Both decline loudly and fall through to the capped preload. The sort check is free (the
footer bytes are already in hand) and runs first, so a rejected element now costs less
than before. `decodeUnsignedIntStat` is new: `morton_code_2d` is `uint32`, which parquet
stores as INT32 with a UINT_32 annotation, and Morton codes use the top bit for real, so
a signed decode reads the far corner of a slide as negative. `mortonCode2dForPoint` /
`mortonBoundsAgreeWithCodes` are exported for the sentinel check, and pin the interleave
convention (x in the even bits) that `zcoverRectangle` and the writer both already assumed
without anything checking they stayed in step.

**`zcoverRectangle` stops at `MORTON_ZCOVER_MAX_DEPTH` (10).** It recursed to the full 16
bits per axis, resolving the rectangle to individual quantised cells when its only job is
picking row groups — **38,014 intervals** to select 92 row groups. At the cap that is 521
intervals selecting the **same 92 row groups**, verified over a viewport tile, the whole
slide and a zoomed-in box. A coarser cell can only widen the covered code range, and the
rows it brings in are filtered against the exact bounds after the read.

Two internal consolidations, no behaviour change: `rowGroupFeatureCodeExtents` and
`rowGroupMortonExtents` were the same footer walk twice and now share
`rowGroupColumnStats`, with the decode left at each call site because that is the part
that depends on the column's logical type. And the two row-group probes each hand-rolled
"memoize the in-flight promise, but forget a `null` or a rejection"; they now share one
`memoizeProbe` built on the existing `evictIfCurrent`, so a late settlement cannot clobber
the retry that superseded it. That pins the half nothing covered — a failed extent probe
must be retried, not remembered, or one transient read leaves the bisect treating a
readable row group as unbounded for the life of the source.
