import type { ShapesElement } from './models/index.js';
import type { SpatialBounds } from './pointsTiling.js';
import type { ShapesRenderData } from './shapes.js';

/**
 * The shapes loader seam (ADR 0003 "Render Resource", mirrored from
 * {@link ./pointsLoader.ts}). It is the deck-free half of the shapes render
 * resource: a strategy that turns a bounds request into a batch, dispatched on
 * {@link ShapesLoaderCapabilities.kind}.
 *
 * ## Deliberately stateless — this is the concurrency contract
 *
 * A loader holds **no mutable per-request state** and keeps **no cache**. It
 * either wraps an already-immutable batch (nothing to load) or delegates each
 * call straight to the element. All lifecycle — dedup, supersession,
 * cancellation, the resident cache — lives in `ShapesResolver`, exactly as it
 * does for points. That split is the whole reason the points races were keying
 * bugs in *one* place (the resolver) and never in the loader: there is no
 * mid-flight field here to flip, no second cache to fall out of sync. Keep it
 * that way. A batch is always built fresh and never mutated after return, so its
 * object identity is a sound invalidation key.
 *
 * ## Encodings
 *
 *  - `wkb-full` — today's honest full-element load. `supportsViewportTiles:
 *    false`; `loadInBounds` ignores `bounds` and returns the whole element,
 *    which is truthful given the capability flag. The only loader that exists in
 *    Phase 0.
 *  - `geoparquet-tiled` / `geoarrow-tiled` — reserved. The viewport-pruning
 *    loader over a Hilbert-sorted GeoParquet artifact, and its GeoArrow-native
 *    variant. Phase 2. See `docs/plans/shapes-nonblocking-tiled-loading.md`.
 */

export type ShapesEncodingKind = 'wkb-full' | 'geoparquet-tiled' | 'geoarrow-tiled';

/**
 * How a {@link ShapesBatch} carries its geometry.
 *
 *  - `decoded-render-data` — today's {@link ShapesRenderData} (JS polygon arrays
 *    / columnar circles), produced on the main thread. The Phase 0 format.
 *  - `geoarrow-buffers` — transferable GeoArrow coordinate + offset buffers from
 *    the worker decode. Reserved for Phase 1; the union grows then.
 */
export type ShapesBatchFormat = 'decoded-render-data' | 'geoarrow-buffers';

export interface ShapesLoaderCapabilities {
  kind: ShapesEncodingKind;
  batchFormat: ShapesBatchFormat;
  /** Known world bounds, if the loader has them at construction. `wkb-full` does
   * not (nothing is loaded yet), so the resolver computes bounds from the loaded
   * geometry instead. A tiled loader reads them from the artifact metadata. */
  bounds?: SpatialBounds;
  supportsViewportTiles: boolean;
}

/**
 * A loaded unit of shapes geometry. Tagged by {@link ShapesBatchFormat} so Phase
 * 1 can add a `geoarrow-buffers` variant without touching {@link CoreShapesLoader}.
 * Immutable once built.
 */
export interface DecodedShapesBatch {
  format: 'decoded-render-data';
  renderData: ShapesRenderData;
  /** Bounds this batch was requested for, echoed for a tiled consumer. Absent on
   * a full load — the batch IS the whole element. */
  bounds?: SpatialBounds;
}

export type ShapesBatch = DecodedShapesBatch;

export interface ShapesLoadInBoundsOptions {
  bounds: SpatialBounds;
  signal?: AbortSignal;
}

export interface CoreShapesLoader {
  readonly capabilities: ShapesLoaderCapabilities;
  /** Load the geometry overlapping `bounds`. A non-tiling loader
   * (`supportsViewportTiles: false`) honestly returns the whole element. */
  loadInBounds(options: ShapesLoadInBoundsOptions): Promise<ShapesBatch | null>;
  /** Load the whole element. Present on non-tiling loaders. */
  loadAll?(options?: { signal?: AbortSignal }): Promise<ShapesBatch>;
}

/**
 * The full-element WKB loader — honest about not tiling. Stateless: it delegates
 * every call to `element.loadRenderData()`, whose decode cache (and the
 * resolver's resident `geometry` resolution) are the *only* caches. It adds none
 * of its own.
 */
export function createFullShapesLoader(element: ShapesElement): CoreShapesLoader {
  const capabilities: ShapesLoaderCapabilities = {
    kind: 'wkb-full',
    batchFormat: 'decoded-render-data',
    supportsViewportTiles: false,
  };

  const load = async (signal?: AbortSignal): Promise<ShapesBatch> => {
    signal?.throwIfAborted?.();
    const renderData = await element.loadRenderData();
    signal?.throwIfAborted?.();
    return { format: 'decoded-render-data', renderData };
  };

  return {
    capabilities,
    // `bounds` is ignored on purpose: a full loader has one batch, the whole
    // element. `supportsViewportTiles: false` is what tells a consumer this.
    async loadInBounds(options: ShapesLoadInBoundsOptions): Promise<ShapesBatch | null> {
      return load(options.signal);
    },
    async loadAll(options?: { signal?: AbortSignal }): Promise<ShapesBatch> {
      return load(options?.signal);
    },
  };
}

/**
 * Pick the encoding for an element. Phase 0 has one answer; the `wantsOptimized`
 * / tiling-metadata branch is reserved for Phase 2 and intentionally not wired
 * yet, so there is no half-built tiled path to reason about.
 */
export function resolveShapesEncoding(): ShapesEncodingKind {
  return 'wkb-full';
}

/**
 * Build the loader for an element. Phase 0: always the full WKB loader. Phase 2
 * adds the `geoparquet-tiled` branch, gated on a `ShapesTilingMetadata` that does
 * not exist yet.
 */
export function createShapesLoaderForElement(element: ShapesElement): CoreShapesLoader {
  return createFullShapesLoader(element);
}
