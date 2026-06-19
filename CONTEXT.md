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

**MobX Control Island**:
A small MDV/control-layer UI area that edits observable state directly while passing plain values through renderer and third-party boundaries.
_Avoid_: MobX renderer contract

## Relationships

- A **Render Stack** contains zero or more ordered **Stack Entries**.
- A **Spatial Entry** is resolved by a **Resource Resolver** before a **Renderer Adapter** creates Viv/deck output.
- A **Host Overlay** is saved as a descriptor and materialized by the host application at runtime.
- A **Group Entry** may order child entries, but does not yet imply framebuffer or blending behavior.
- A **MobX Control Island** may edit MDV state directly, but default SpatialData.js renderer APIs remain plain-object APIs.

## Example Dialogue

> **Dev:** "Can I put MDV scatter between an image and labels?"
> **Domain expert:** "Yes — make the scatter a **Host Overlay** entry in the **Render Stack** and let MDV resolve it into a deck layer."

## Flagged Ambiguities

- "Layer" was used for SpatialData elements, deck.gl layer instances, UI rows, and saved config entries. Resolved: use **Stack Entry** for saved/render order, **Spatial Entry** for SpatialData-backed entries, and deck.gl layer only for runtime renderer output.
- "Snapshot" was used for both persisted config and temporary UI/render state. Resolved: persisted config is a **Render Stack**; live MDV direct-edit areas are **MobX Control Islands** and should not periodically snapshot the whole stack during interaction.
