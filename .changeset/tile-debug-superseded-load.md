---
"@spatialdata/layers": patch
---

Points: stop the tile debug overlay marking a tile as errored when its data resolved.

Two loads for one tile can be in flight at once. deck restarts a tile whenever
`needsReload` is set — after an abort, or when a `getTileData` update trigger changes,
which the feature filter does on every toggle — and `Tile2DHeader.loadData` does not
await the attempt it replaces. deck guards its own state against the loser with a
`_loaderId` compared after the await, and throws the stale result away; the debug hooks
are called from *inside* `getTileData`, upstream of that check, so they had no such
guard. When the abandoned load rejected last, the overlay painted a tile red that deck
was holding good content for.

`onTileLoadStart` now returns an attempt id and `onTileLoadEnd` requires it back; a
report whose id is no longer current is dropped, leaving the store untouched so it does
not even notify. The id is required rather than optional so that forgetting to pass it
cannot quietly reinstate the race.

The mirror case matters too, and is covered: a stale *success* landing while the
replacement is still in flight would otherwise claim a tile is done when nothing has
drawn it.

Behaviour outside the overlay is unchanged — this is a reporting bug, not a loading
one. The points themselves were always correct.
