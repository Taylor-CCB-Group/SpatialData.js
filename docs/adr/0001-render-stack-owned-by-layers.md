# Render Stack Owned By Layers

> **Amended by [ADR 0004](0004-resource-resolver-owned-by-core.md) (2026-07-14).**
> The **package-placement** claim below is superseded: `RenderStack` lives in
> `@spatialdata/core`, not `@spatialdata/layers`. The **Resource Resolver** takes a
> Render Stack as input and is renderer-agnostic, so dependency direction forces the
> move. Everything else in this ADR stands unchanged — host overlays as descriptors,
> no parallel `layerOrder` state, MobX outside the contract.

The canonical ordered render description lives in `@spatialdata/layers` as `RenderStack`, while `@spatialdata/vis` adapts that stack into React, Viv, and deck.gl rendering. Host overlays are saved as descriptors and resolved by the host application at runtime, so MDV can interleave scatter, gates, selections, and SpatialData entries without storing raw deck layer instances or reintroducing parallel `layerOrder` / `stackOrder` state.

MobX may be used by MDV-facing control UI, but it is not part of the `@spatialdata/layers` contract or the default renderer API. MobX-controlled panels should be explicit control islands, especially while adopting React Compiler, because observable direct editing and automatic memoization have different assumptions.
