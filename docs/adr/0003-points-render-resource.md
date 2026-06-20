# Points Render Resource

ADR 0002 describes persisted Morton Parquet artifacts and bounded loading APIs on
`PointsElement`. This ADR describes the **render-time** boundary between store
I/O, the Resource Resolver, and the deck.gl `PointsLayer` composite.

## Decision

- A points **Spatial Entry** (`PointsElement`) remains the canonical spatial
  identity handle. Deck layers stay associated with that element for picks,
  tooltips, and Render Stack `elementKey`.
- The **Resource Resolver** (today `resolvePointsRenderResource()` in
  `@spatialdata/vis`) probes once and returns a **Points Render Resource**
  bundle `{ element, loader }` with **frozen** encoding capabilities.
- **`PointsLoader`** is the loader facet only: encoding kind, batch format,
  bounds, and fetch methods. Render strategies call `loader.loadInBounds()` —
  not `element.loadPointsInBounds()` directly from `@spatialdata/layers`.
- **`PointsLayer`** (`@spatialdata/layers` `CompositeLayer`) takes
  `resource: PointsRenderResource` plus cosmetic props. It delegates to
  encoding-specific render strategies selected by `loader.capabilities.kind`.
- **Store I/O loader factories** live in `@spatialdata/core` and close over
  `PointsElement`. **Render strategies** and tile-debug overlay logic live in
  `@spatialdata/layers`. The vis resolver associates element + loader.

## Encoding selection (v1)

| Condition | Encoding kind | Strategy |
|-----------|---------------|----------|
| Full table preloaded in resolver cache | `preloaded-columnar` | `ScatterplotLayer` |
| Morton metadata with row-group range reads + bounds | `morton-tiled` | `TileLayer` + per-tile scatter |
| Future GeoArrow batch from core | `geoarrow-binary` | stub → `GeoArrowScatterplotLayer` |
| Future tiled Arrow/Parquet deck path | `geoarrow-tiled` | stub |

Resolver probing is **eager**: capabilities do not change mid-session unless
the element or resolver cache inputs change.

## GeoArrow boundary

- **Core** may later expose deck-free Apache Arrow `RecordBatch` batches from
  Parquet row groups (x/y/z columns or geometry).
- **Layers** owns [deck.gl-geoarrow](https://github.com/geoarrow/deck.gl-geoarrow)
  integration: GeoArrow geometry shaping and `GeoArrowScatterplotLayer` /
  future tiled deck paths.
- Core must not import deck.gl or `@geoarrow/deck.gl-geoarrow`.

## Batch contract

`PointsBatch` is a tagged union:

- `columnar-ndarray` — v1 Morton and preloaded paths
- `arrow-record-batch` — reserved for GeoArrow strategies

## Tile debug overlay

When `showTileDebugOverlay` is enabled on a tiled encoding, the morton strategy
emits a pickable `PolygonLayer` sublayer with per-tile status (pending, loading,
loaded, empty, error, aborted). This is cosmetic for tile fetching and must not
appear in `TileLayer.updateTriggers.getTileData`.

## Relationship to ADR 0002

- ADR 0002: persisted artifacts and `PointsElement.loadPointsInBounds()` API.
- ADR 0003: render-time bundle, strategy registry, and deck composite ownership.

## Consequences

- Swapping encodings or deck.gl parquet layers requires new loader factories
  and/or strategies — not changes to `PointsLayer` public props.
- `PointsElement` does not grow a mutable `renderResource` attachment; the
  resolver cache holds stable bundle references per element key.
- Image precedent: `ImageElement` + Viv loader built in vis; points precedent:
  `PointsElement` + `PointsLoader` built in vis, rendered by `PointsLayer`.
