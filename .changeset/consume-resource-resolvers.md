---
"@spatialdata/vis": patch
---

useLayerData consumes the Resource Resolvers via a single reconcile loop.

`useLayerData` now drives layer loading through `@spatialdata/core`'s
`SpatialEntryStore.reconcile()` over per-kind `ResourceResolver`s — `PointsResolver`
/ `ShapesResolver` from `core`, `ImagesResolver` / `LabelsResolver` from `vis` —
instead of the previous per-kind `Promise.all` load switch. Shapes geometry/tooltip/
fill-colour rows, image and labels channel defaults, and points preload are all read
from their resolvers; points continue to run through the stable `PointsDataEngine`,
which the store borrows via a non-owning proxy so a dataset swap does not dispose it.

Purely an internal restructuring behind ADR 0004 (Step 1 consumption): the 17-member
public surface is unchanged and guarded by `useLayerData.spec.tsx`.
