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
- Render-time code uses ADR 0003's **Points Render Resource** (`{ element,
  loader }`) and calls the `PointsLoader` facet. `PointsElement` remains source
  identity and public source API, not the deck strategy contract.
- `@spatialdata/vis` may render compatible points through a deck.gl `TileLayer`.
  The tile layer owns async viewport loads and abort signals; ordinary
  `ScatterplotLayer` rendering remains the fallback for preloaded point data.
- `points.experimental/<key>` and `shapes.experimental/<key>` are reserved as
  top-level Experimental Optimization Collections. They link back to the source
  element by key and metadata rather than modifying canonical SpatialData
  element semantics.
- GeoParquet is the durable shape optimization target. GeoArrow is a runtime
  columnar layout / deck adapter option, not a duplicate persisted artifact.

## Experimental Optimization Collections

Use `points.experimental/<key>/` and `shapes.experimental/<key>/` only for
persisted layouts that **standard SpatialData / Vitessce readers cannot correctly
consume** — not for every browser optimization.

| Layout | Where it lives | Why |
|--------|----------------|-----|
| **Morton v1** (`morton_code_2d`, sentinels, `{feature_key}_codes`, row groups) | **Canonical** `points/<key>/points.parquet` | Follows Vitessce practice. Extra columns are additive; Python `spatialdata` full-table reads still work. |
| **Feature-primary sort** (Morton not primary key) | `points.experimental/<key>/` | Breaks Morton row-group bisect; needs a new tiling `kind` |
| **Padua multiscale** (`__spatial_index__`, levels in schema metadata) | `points.experimental/<key>/` | Non-standard vs morton-points v1 |
| **GeoParquet shapes tiling** | `shapes.experimental/<key>/` | Future |

`experimentalOptimizations` in `@spatialdata/vis` means use TileLayer / row-group
reads when **canonical** parquet schema supports morton tiling — not “look in
`points.experimental/`”.

The experimental writer defaults to **in-place** Morton sorting on
`points/<key>/points.parquet`. Use `--experimental` only when writing a layout
that must not replace the canonical element.

## Multi-part Parquet (reader)

Wild-type SpatialData points may store `points/<key>/points.parquet` as a
**directory** with `part.0.parquet`, `part.1.parquet`, … The logical path remains
`points/<key>/points.parquet`. `@spatialdata/core` supports both single-file and
multipart layouts for metadata, schema, and row-group range reads. The
experimental writer outputs a **single-file** Morton artifact by design; row-group
range reads fetch only the byte ranges needed per viewport.

## Feature / gene filtering

Transcript and other feature-bearing points declare `feature_key` in element
`spatialdata_attrs` (for example `"feature_name"` on xenium transcripts). This is
distinct from `instance_key` (for example `"cell_id"`), which identifies the
object a point belongs to.

The Morton writer adds `{feature_key}_codes` (for example `feature_name_codes`)
as `int32` categorical codes alongside the string feature column. Sorting is
**spatial** (Morton on x/y) by default; row groups are spatial chunks.

**Core API** — extend bounded loading with optional feature codes:

```typescript
interface PointsInBoundsOptions {
  bounds: SpatialBounds;
  /** Integer codes matching `{feature_key}_codes` in the parquet artifact */
  featureCodes?: readonly number[];
  signal?: AbortSignal;
}
```

**Vis API** — extend `PointsLayerConfig` with `featureCodes?: number[]` and
wire through TileLayer `updateTriggers.getTileData`.

v1 applies feature filtering as a **read-time row predicate** after spatial
bounds filtering (and after row-group fetch on the Morton path). It does not
skip row groups by gene. String-based `features?: string[]` and a codebook
artifact are deferred.

**Implementation status** (preload vs runtime filter, catalog, workers):
[`docs/plans/points-preload-feature-filter-status.md`](../plans/points-preload-feature-filter-status.md).

Feature filtering is separate from **feature-primary sort** experiments
(`[feature_codes, morton_code_2d]`), which may require a new tiling `kind` if
promoted. Use `write-index-permutations` on a derivative Zarr store to benchmark
sort strategies; see the writer README.

A hypothetical **per-gene density map** (2D histogram / KDE for one feature) is
out of scope for the Morton tile path and may be an offline aggregation or
dedicated viz mode later.

## Sort strategy experiments

Default Morton v1 sort is spatial on `morton_code_2d` (optionally `z` when
low-cardinality). Multi-key sorts under evaluation include
`[morton_code_2d, feature_name_codes]` and `[feature_name_codes, morton_code_2d]`.
The reader's row-group bisect assumes Morton is the **primary** sort key; do not
silently swap sort order under the existing `morton-points` format id.

Generate comparable permutations with:

```bash
spatialdata-experimental-writer write-index-permutations SOURCE_ZARR DEST_ZARR
```

The derivative store includes sibling `points/<condition>/` elements and
`index-manifest.json` for benchmark tooling.

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
