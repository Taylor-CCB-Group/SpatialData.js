# Spatially-Aware Vector Loading

SpatialData points and shapes can be large enough that whole-element Parquet
loads are not a viable browser default. We will treat viewport-bounded vector
loading as a first-class source API and keep persisted optimization artifacts in
Parquet/GeoParquet rather than inventing a deck.gl-specific storage format.

## Decision

- Points v1 follows current Vitessce practice: a SpatialData Points Parquet
  element may be sorted by 2D Morton order with a `morton_code_2d` column, a
  feature-code column, controlled row-group sizes, and 2-4 leading sentinel rows
  whose `morton_code_2d` is `0` and whose coordinates encode the full point
  extent.
- `@spatialdata/core` exposes bounded point loading through
  `PointsElement.loadPointsInBounds()`. When the Parquet module supports
  Vitessce's row-group APIs (`readMetadata` and `readParquetRowGroup`) and the
  store supports range reads, the loader may fetch selected row groups. Otherwise
  it degrades to the existing full-table read followed by bounds filtering.
- `@spatialdata/vis` may render compatible points through a deck.gl `TileLayer`.
  The tile layer owns async viewport loads and abort signals; ordinary
  `ScatterplotLayer` rendering remains the fallback for preloaded point data.
- `points.experimental/<key>` and `shapes.experimental/<key>` are reserved as
  top-level Experimental Optimization Collections. They link back to the source
  element by key and metadata rather than modifying canonical SpatialData
  element semantics.
- GeoParquet is the durable shape optimization target. GeoArrow is a runtime
  columnar layout / deck adapter option, not a duplicate persisted artifact.

## Prior Art

- scverse Padua hackathon points work:
  <https://github.com/scverse/2026_04_hackathon_padua/issues/17> and
  <https://github.com/scverse/2026_04_hackathon_padua/issues/24>.
- Padua branch prototype:
  <https://github.com/scverse/2026_04_hackathon_padua/tree/viz/point_chunking/visualization>.
- Vitessce tiled SpatialData Points:
  <https://github.com/vitessce/vitessce/pull/2286>.
- Vitessce sentinel bbox update:
  <https://github.com/vitessce/vitessce/issues/2419> and
  <https://github.com/vitessce/vitessce/pull/2489>.
- Vitessce shapes format `0.3` compatibility:
  <https://github.com/vitessce/vitessce/pull/2495> and
  <https://github.com/vitessce/vitessce/releases/tag/v3.9.11>.

## Consequences

- Source loaders must expose typed/columnar batches and remain independent of
  deck.gl. Rendering packages decide whether to use TileLayer, ScatterplotLayer,
  or a future GeoArrow-aware layer.
- Whole-table point loading is still supported and is the compatibility fallback,
  but render paths can opt into experimental optimizations with a single
  `experimentalOptimizations` switch.
- Shapes format `0.3` remains on the current modern Parquet-backed path in
  `VShapesSource`; large-shape spatial tiling still needs a separate GeoParquet
  artifact/writer slice.
