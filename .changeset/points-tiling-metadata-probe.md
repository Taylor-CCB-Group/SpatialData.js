---
"@spatialdata/core": patch
"@spatialdata/layers": patch
---

Points: probe for a Morton-tiled artifact before committing to a full-table preload
(D5 step 1).

`PointsResolver` gains a `tiling` resource — a one-key `RequestSlot` holding the
element's **tileable** Morton metadata, or `null` when the element cannot drive
viewport tiles (no Morton artifact, no row-group range reads, no bounds, or a failed
probe). `plan()` now asks `planPointsLoads` for both decisions at once, so a tileable
element no longer schedules a full-table preload it would immediately throw away, and
the row-codes / feature-index-scan tasks — both defined against the resident batch —
wait for the same answer.

This is **opt-in and inert by default**: the new `PointsResolveConfig.pointsTiling`
defaults to `'off'`, which collapses planning to exactly today's behaviour. Nothing
renders through the tiled path yet — that is the next step of
`docs/plans/points-morton-tiled-viewport-loading.md`.

- **`@spatialdata/core`** additionally exports `planPointsLoads` (moved from
  `@spatialdata/layers` so the resolver can call it) and the resolver reads
  `getTilingMetadata` / `isTiled` / `isTilingSettled`. A failed probe is a retryable
  `failed` resolution that still reports "cannot tile", so the layer falls through to
  the ordinary preload rather than stranding.
- **`@spatialdata/layers`** re-exports `planPointsLoads` from core; no consumer import
  moves.
