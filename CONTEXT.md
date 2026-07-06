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

**Points Feature**:
The categorical identity of a point, read from the points parquet column named by that element's `.zattrs` `feature_key` (e.g. `feature_name` — a gene/transcript species). This is the key that points **filter** and **colour-by** operate on. Distinct from the shape/table sense of "feature" (a column of an annotation `table`); a points element usually has no annotation table — the point *is* its own row.
_Avoid_: assuming the column is literally `feature_name`; conflating with table-annotation features or `table.vars`

**Feature Code**:
An integer standing in for a **Points Feature** value. Authoritative only when the store emits an explicit `{feature_key}_codes` column (e.g. `feature_name_codes`), which is a global namespace aligned with the feature catalog. A dictionary-encoded `feature_key` column is **not** a code source: its dictionary indices are local to a chunk/row-group/part and must be mapped through the catalog by decoded string, never treated as global codes.
_Avoid_: treating dictionary indices as global codes

**Instance Key**:
The points parquet column named by `.zattrs` `instance_key` (e.g. `cell_id`) — the instance a point belongs to. Reserved for future instance/table linking; not used in the current MVP.
_Avoid_: wiring instance-key behaviour into MVP filter/colour/tooltip

**Point Attribute Column**:
Any other column of the same points parquet row (`x`, `y`, `z`, `qv`, `overlaps_nucleus`, …), surfaced in a per-point **tooltip**. Not the filter/colour key.
_Avoid_: calling the points tooltip a "feature tooltip"; pulling tooltip values from a joined table in MVP

**Feature Highlight**:
Transient, interactive emphasis of *all* points belonging to one chosen **Points Feature** (e.g. hovering a gene in the catalog panel brightens its points and de-emphasises the rest). It is ephemeral **runtime** state — a cheap recolor/re-emphasis of the already-resident batch with **no reload or refilter** — not part of the serializable colour encoding or **Render Stack** config. Distinct from deck.gl `autoHighlight`, which emphasises a single *picked point*, not a whole feature.
_Avoid_: persisting highlight into the Stack Entry; conflating with per-object `autoHighlight`; reloading geometry on highlight change

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
