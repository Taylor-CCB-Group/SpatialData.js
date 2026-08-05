---
'@spatialdata/core': patch
'@spatialdata/vis': patch
---

Make a fill-colour column (or tooltip field) switch actually apply for a host that
edits its layer configs in place.

Two independent breaks sat between "the user picked a different column" and "the
canvas shows it", and a host only hit them together. #119 fixed the third thing in
that chain — the load-window blank — which is why the remaining two read as "the
colours just never change".

**The change never reached the resolver.** `useLayerData`'s reconcile effect is the
one place a config change turns into a request, and it was keyed on the identity of
`layers` and the configs inside it. That assumes the caller allocates a fresh config
per edit; MDV's render-stack adapter deliberately does the opposite, keeping one
`LayerConfig` per Stack Entry so a cosmetic edit does not look structural and
re-enter geometry loads. Under that caller the effect never re-ran: the new column
was never requested, `getShapeFillColorEntry` / `getLabelFillColorEntry` went on
correctly serving last-good rows, and last-good was all there would ever be. The
effect now also depends on `describeResolveInputs` — a value key over exactly the
config fields each resolver's `plan()` reads, recomputed per render because a
mutation is invisible to any memo. It holds scalars and short id lists only; a
palette swap or an opacity drag does not move it, so nothing replans on a slider.

**The settle never reached React.** `SpatialEntryStore` subscribed to its resolvers
in its constructor and tore that bridge down in `dispose()` — which `useLayerData`
calls from an effect cleanup. An effect cleanup is not "the end": StrictMode's dev
double-mount runs cleanup and then re-runs the effect against the same memoised
store, after which the store was permanently deaf to its own resolvers. Every async
settle from then on was dropped, so rows that landed after a switch did not repaint
until an unrelated re-render (a pan) came along. The bridge is now attached on the
first listener and detached on the last, so it is exactly as long-lived as someone
caring about it and survives any number of remounts. `getVersion()` became a derived
sum of the resolvers' versions rather than a counter the bridge maintained, so it
stays true whether or not anything is subscribed.

No public API change. Verified against MDV driving only `fillColorByColumn` on a
labels layer: switching to a column that has to be fetched now repaints on its own.
