# @spatialdata/layers

deck.gl–native home for composable spatial rendering: a top-level `SpatialLayer` `CompositeLayer` and a versioned, JSON-serializable `SpatialLayerProps` contract (Zod + `migrateSpatialLayerProps`).

## Public API

- `SpatialLayer` — validates props and will orchestrate image / scatter / shapes sublayers as they are ported from `@spatialdata/vis` and MDV patterns.
- `spatialLayerPropsSchema`, `migrateSpatialLayerProps`, `SPATIAL_LAYER_PROPS_SCHEMA_VERSION` — runtime validation and config migration for saved views and integrators (e.g. MDV).

## Dependencies

- **Peers:** `deck.gl`
- **Deps:** `zod`, `@math.gl/core` (for future transforms)

`@spatialdata/avivatorish` and `@spatialdata/core` are intentionally not required yet; wire them in as sublayer implementations land.

## Non-goals

- No MobX; props are plain data.
- This package does not own React UI — use `@spatialdata/vis` / `SpatialCanvas` for shells and panes.
