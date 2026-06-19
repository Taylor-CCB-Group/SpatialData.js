# Render Stack Owned By Layers

The canonical ordered render description lives in `@spatialdata/layers` as `RenderStack`, while `@spatialdata/vis` adapts that stack into React, Viv, and deck.gl rendering. Host overlays are saved as descriptors and resolved by the host application at runtime, so MDV can interleave scatter, gates, selections, and SpatialData entries without storing raw deck layer instances or reintroducing parallel `layerOrder` / `stackOrder` state.

MobX may be used by MDV-facing control UI, but it is not part of the `@spatialdata/layers` contract or the default renderer API. MobX-controlled panels should be explicit control islands, especially while adopting React Compiler, because observable direct editing and automatic memoization have different assumptions.
