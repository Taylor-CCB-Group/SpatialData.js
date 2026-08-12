---
"@spatialdata/core": patch
---

Points: refuse to Morton-tile a file whose `morton_code_2d` column is not sorted.

Having the column does not make a file Morton-ordered. A feature-primary artifact —
sorted `(feature, morton)` — carries the identical column with identical, correct values,
a correct sentinel box, and every field the tiling probe looks for. Only the order is
wrong, and nothing in the file said so. The row-group bisect binary-searches that index
assuming it ascends, so it landed arbitrarily and a tile came back holding whichever
feature blocks happened to live in the row groups it picked: some tiles showed one or two
genes, most showed none.

The probe now reads the per-row-group `[min, max]` for the Morton column out of the
parquet footer and requires it to be non-decreasing. On the permutations store,
`transcripts_feature_then_morton` descends at 185 of its 244 row-group boundaries while
both morton-primary elements descend at none — including `transcripts_morton_then_feature`,
so a *secondary* feature key stays supported and the test is on the file rather than the
element's name.

The check is free: `datasetMetadata.parts` already carries the footer bytes when the probe
runs, and the statistics are complete. Failing it also skips the sentinel sampling read,
since the outcome can no longer change, so a rejected element now costs less than before.
The element still loads through the capped preload, and its feature-code row-group index
on that path — a separate mechanism — is unaffected.

Adds `decodeUnsignedIntStat`: `morton_code_2d` is `uint32`, which parquet stores as INT32
with a UINT_32 annotation, and Morton codes use the top bit for real, so `decodeIntStat`
would read the far corner of a slide as negative.
