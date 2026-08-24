---
"@spatialdata/layers": patch
"@spatialdata/vis": patch
---

Points: tooltips on the tile debug overlay, and stop it drawing tiles deck has dropped.

**Tooltips.** `formatPointsTileDebugTooltip` and `isPointsTileDebugPickObject` were both
written, exported and tested, the overlay's polygons already carried the pick kind — and
nothing in `vis` consumed any of it, so hovering a tile did nothing. `getFeatureTooltip`
now recognises a tile-debug pick and returns the formatted entry: tile id, status, the
viewport's batch progress, index, bbox and clipped bbox, duration or elapsed, point
count, load mode, and the **error message**. That last one is the point — the overlay can
only paint a rectangle a colour, so "which tile, and why" had nowhere to appear.

**Stale tiles.** The overlay only ever grew. `completedTilesById` is one of the sources
the active set is rebuilt from and nothing pruned it, so every tile ever loaded stayed
painted — including tiles from a zoom level the view had left, drawn over ground the
current tiles had since rendered. Measured live: 62 rectangles for a 44-tile viewport,
the extra 18 at a zoom level no longer in use, four of them `aborted` and not even in
deck's cache any more. `aborted` fills dusty red, which at a glance is an error on a tile
whose data resolved — reachable by panning and zooming alone.

The multi-level tile grid is what made it visible: with a single fixed zoom level there
was never a tile at another `z` to leave behind.

Fixed by wiring deck's own `onTileUnload`, which is the right boundary — while a tile is
in deck's cache it can be reused and belongs on the overlay; once evicted it does not.
The invariant now holds live: nothing is drawn that deck is not holding.

Also raises the timeout on the feature-catalog tests that build a parquet fixture through
`uv run python`, matching the 120s their own `beforeAll` already uses. vitest's 5s default
is not a budget for that, and they timed out intermittently under full-suite parallelism
while passing in isolation — a flaky-looking product from a slow fixture. Pre-existing;
reproduced on a clean tree.
