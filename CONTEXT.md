# SpatialData.js Rendering Context

Canonical language for SpatialData.js rendering, renderer integration, and MDV-facing state work.

## Language

**Render Stack**:
An ordered, serializable description of what should be drawn in a spatial viewport.
_Avoid_: `layerOrder`, `stackOrder`, parallel layer maps

**Stack Entry**:
One ordered item in a **Render Stack**, identified by a stable `id` and split into structural `source` identity plus renderer `props`.
_Avoid_: ad-hoc layer descriptor

**Spatial Entry**:
A **Stack Entry** whose source is a SpatialData element such as an image, shapes, points, or labels element.
_Avoid_: treating every entry as a deck layer

**Host Overlay**:
A **Stack Entry** whose source is owned by the host application and resolved at runtime into one or more deck.gl layers.
_Avoid_: external layer tail, raw saved deck layer

**Group Entry**:
A reserved **Stack Entry** that names ordered children for future blending or aggregation behavior.
_Avoid_: framebuffer layer until the rendering behavior exists

**Resource Resolver**:
The store-agnostic boundary that turns structural **Render Stack** inputs into stable loaded resources for renderers.
_Avoid_: viewer-local cache, periodic snapshotter

**Renderer Adapter**:
The code that turns resolved resources plus entry props into Viv/deck layer instances.
_Avoid_: state store

**Runtime Attachment**:
An unsaved function or object supplied by the host application alongside a **Render Stack**, such as `hostLayerResolver`, `onFeatureHover`, `onFeatureClick`, raw deck handlers, DOM portal targets, or deck layer factories.
_Avoid_: serializable prop, stack entry prop

**MobX Control Island**:
A small MDV/control-layer UI area that edits observable state directly while passing plain values through renderer and third-party boundaries.
_Avoid_: MobX renderer contract

**Points Render Resource**:
The **Resource Resolver** output for a points **Spatial Entry**: a bundle `{ element, loader }` pairing the canonical `PointsElement` with a frozen **`PointsLoader`** facet.
_Avoid_: treating `PointsLoader` alone as the full render resource, or storing the loader on/mutating the element

**PointsLoader**:
The loader facet of a **Points Render Resource**: encoding capabilities plus a fetch API (`loadInBounds`, optional `loadAll`). Built by `@spatialdata/core` store-I/O factories; consumed by `@spatialdata/layers` render strategies — not by calling `PointsElement` methods directly from deck code.
_Avoid_: conflating with Viv/image `loader` when discussing SpatialData element identity

**Points Encoding**:
The render-time points layout selected after resolver probing, e.g. `preloaded-columnar`, `morton-tiled`, or future `geoarrow-*` kinds. Distinct from persisted Parquet layout described in ADR 0002.
_Avoid_: `experimentalOptimizations` as a synonym for encoding kind

## Relationships

- A **Render Stack** contains zero or more ordered **Stack Entries**.
- A **Spatial Entry** is resolved by a **Resource Resolver** before a **Renderer Adapter** creates Viv/deck output.
- A **Host Overlay** is saved as a descriptor and materialized by the host application at runtime.
- A **Group Entry** may order child entries, but does not yet imply framebuffer or blending behavior.
- A **Runtime Attachment** may observe or materialize stack entries, but is not part of saved **Render Stack** config.
- A **MobX Control Island** may edit MDV state directly, but default SpatialData.js renderer APIs remain plain-object APIs.

## Example Dialogue

> **Dev:** "Can I put MDV scatter between an image and labels?"
> **Domain expert:** "Yes — make the scatter a **Host Overlay** entry in the **Render Stack** and let MDV resolve it into a deck layer."

## Flagged Ambiguities

- "Layer" was used for SpatialData elements, deck.gl layer instances, UI rows, and saved config entries. Resolved: use **Stack Entry** for saved/render order, **Spatial Entry** for SpatialData-backed entries, and deck.gl layer only for runtime renderer output.
- "Snapshot" was used for both persisted config and temporary UI/render state. Resolved: persisted config is a **Render Stack**; live MDV direct-edit areas are **MobX Control Islands** and should not periodically snapshot the whole stack during interaction.
- "Props" was used for both serialized renderer inputs and runtime callback objects. Resolved: `entry.props` must remain serializable renderer input; listeners, factories, portals, and raw deck integration points are **Runtime Attachments**.
