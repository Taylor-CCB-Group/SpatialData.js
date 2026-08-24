---
"@spatialdata/vis": minor
---

Key the resource caches by element identity, not by element name, so a dataset swap
cannot serve one dataset's points for another's element ([#162](https://github.com/Taylor-CCB-Group/SpatialData.js/issues/162)).

`PointsDataEngine` is created once and deliberately outlives a `spatialData` swap — the
feature panels subscribe to it directly and its render-resource memos must keep their
identity — but every entry in it was keyed by the element's *name*. Element names repeat
across datasets by convention: two Xenium runs both have `transcripts`, `cell_boundaries`
and `morphology_focus`. So after a swap, the new dataset's element was served the previous
one's entry — its preload, its catalog, its row codes, its feature-index scan, its Morton
tiling metadata. MDV swaps datasets exactly this way, keeping the layer config shape and
the element names, so this was reachable rather than latent.

The tiling slot was the one that failed quietly. `PointsRendererAdapter.getTiledResource`
already rebuilds for a new element, so it built a *correct* loader for the new element
parameterised by the previous artifact: its `parquetPath`, its `bounds`, its
`rowGroupMortonExtents`. Viewport rectangles were normalised against the wrong
quantisation domain and row groups selected from the wrong index. Points were never
misplaced — the reader re-filters to the query bounds — so the symptom was that part of
the map was simply missing, with no error anywhere. The world bounds derived from that
metadata framed the previous dataset's extent, and the tile-status overlay kept painting
the previous dataset's tiles.

`AvailableElement.key` is now the element's name qualified by the identity of the element
object, and the new `AvailableElement.name` is the plain name. The split follows what each
string is for: **names** address elements from outside — `LayerConfig.elementKey`, layer
ids, `reloadElement`, `getImageLoadedDataByElementKey`, tooltip and pick payloads, the
host colour and viv resolvers — and **keys** address caches. Nothing in the public config
surface changes shape; a host that passes `elementKey: 'transcripts'` keeps working, and
the two public getters that take a name translate at the boundary. Build an
`AvailableElement` with `availableElement(...)` rather than by hand, and never key a cache
on a name.

Fixed at the boundary where the key is decided rather than in the tiling slot alone: the
other slots carried the identical exposure, and a per-slot repair would have made the code
look like the question had been settled. It also keeps what the engine surviving a swap
was for — the previous dataset's entries are still resident, so swapping back to it hits
the cache instead of reloading. Those entries are not evicted when their dataset goes
away; bounding these caches by bytes is
[ADR 0005](https://github.com/Taylor-CCB-Group/SpatialData.js/blob/main/docs/adr/0005-memory-accounting-before-management.md)
rung 2, not this change.
