---
'@spatialdata/core': patch
'@spatialdata/vis': minor
---

Distinguish a feature that is fully loaded from one the memory cap only sampled.

`resident` means a feature has **at least one** point inside the memory cap. On a
truncated element that is true of nearly every feature, so the panel greyed nothing,
showed each feature's full dataset count beside it, and presented a sample as the
whole answer. On a Xenium transcripts element (8.07M points, 4M cap) all 541
features read as resident while half the data was absent.

`describeFeatureRowState` takes optional `residentPointCount` / `datasetPointCount`
and returns a new `partial` tone — drawn, so not greyed, but labelled and explained
with both counts and the share. A completed feature-index scan vetoes it: that
supplies the feature whole, so its resident shortfall is no longer what is on screen.
The built-in panel shows `resident / dataset` on those rows and a summary line, and
falls back to the previous behaviour whenever counts are unknown.

Fixes a latent bug this exposed: `getResidentFeatureCounts` answered from the preload
result's own tally, which is frozen in the resident preview's code space and is not
remapped when the full catalog supersedes it. For a dictionary-only element that
attributed one gene's count to another. Counts now derive from the reconciled row
codes, memoised on the same identity as the resident-codes set.
