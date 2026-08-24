---
"@spatialdata/layers": patch
"@spatialdata/vis": patch
---

Points: make the tile debug overlay tell the truth — tooltips, no stale tiles, no false
errors.

The overlay can only paint a rectangle a colour, so "which tile, and why" had nowhere to
appear, and three separate things conspired to make good tiles look broken.

**Tooltips.** `formatPointsTileDebugTooltip` and `isPointsTileDebugPickObject` were
written, exported and tested, and the overlay's polygons already carried the pick kind —
but nothing in `vis` consumed any of it, so hovering a tile did nothing. `getFeatureTooltip`
now recognises a tile-debug pick and returns the formatted entry: tile id, status, the
viewport's batch progress, index, bbox and clipped bbox, duration or elapsed, point count,
load mode, and the error message.

**Tiles deck had already dropped stayed painted.** `completedTilesById` is one of the
sources the active set is rebuilt from and nothing pruned it, so the overlay only ever
grew — including tiles from a zoom level the view had left, drawn over ground the current
tiles had since rendered. Measured live: 62 rectangles for a 44-tile viewport, the extra
18 at a zoom level no longer in use. Wiring deck's own `onTileUnload` is the right
boundary: while a tile is in deck's cache it can be reused and belongs on the overlay;
once evicted it does not. The multi-level grid is what made this visible — with a single
fixed zoom level there was never a tile at another `z` to leave behind.

**A superseded load reported over the one that replaced it.** Two loads for one tile can
be in flight at once: deck restarts a tile whenever `needsReload` is set — after an abort,
or when a `getTileData` update trigger changes, which the feature filter does on every
toggle — and `Tile2DHeader.loadData` does not await the attempt it replaces. deck guards
its own state with a `_loaderId` compared after the await, but the debug hooks run *inside*
`getTileData`, upstream of that check. When the abandoned load rejected last, the overlay
painted a tile red that deck was holding good content for. `onTileLoadStart` now returns an
attempt id and `onTileLoadEnd` requires it back; the id is required rather than optional so
that forgetting to pass it cannot quietly reinstate the race. The mirror case is covered
too: a stale *success* would otherwise claim a tile is done when nothing has drawn it.

**`aborted` no longer looks like an error.** It was a dusty red — `[180, 80, 80]` against
`error`'s `[220, 60, 60]` — so a cancelled request was indistinguishable at a glance from
a failed one, and four of those stale rectangles were sitting in `aborted` over perfectly
good data. It is a violet now, at a low alpha, because a request the viewport moved on
from is the least interesting thing on the overlay. `error` is additionally marked out by
weight (`tileDebugStatusLineWidth`, 4px against 2px): `loaded` green against `error` red is
the classic red-green pair, so hue alone does not carry it for everyone, and neither does
opacity, since `loading` is deliberately fully opaque too. An abort also no longer sets
`errorMessage` — it was the literal string `'aborted'`, which the new tooltip rendered as a
row labelled **error** reading *aborted*, the same red herring in words. Red now means
exactly one thing.

Behaviour outside the overlay is unchanged throughout — these are reporting bugs. The
points themselves were always correct.

Also raises the timeout on the feature-catalog tests that build a parquet fixture through
`uv run python`, matching the 120s their own `beforeAll` already uses. vitest's 5s default
is not a budget for that, and they timed out intermittently under full-suite parallelism
while passing in isolation. Pre-existing; reproduced on a clean tree.
