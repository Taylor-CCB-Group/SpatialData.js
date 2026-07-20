/**
 * Hook for loading and caching layer data
 *
 * Handles async loading of geometry data (shapes, points) and manages
 * loading state for each layer.
 */

import { getImageSize } from '@hms-dbmi/viv';
import type { Matrix4 } from '@math.gl/core';
import { clampVivSelectionsToAxes } from '@spatialdata/avivatorish';
import {
  type AnyResolveContext,
  type AxisAlignedBounds,
  attachTooltipElementContext,
  boundsFromCircles,
  boundsFromFlatPolygonPositions,
  boundsFromImagePixelExtents,
  boundsFromPoints,
  boundsFromPolygons,
  getPhysicalSizeScalingMatrixFromMeta,
  getTooltipSignature,
  type LabelsElement,
  type PointsElement,
  resolvePointsMemoryCap,
  resolveTooltipItems,
  type ShapesElement,
  type ShapesRenderData,
  ShapesResolver,
  type SpatialData,
  SpatialEntryStore,
  type SpatialFeatureTooltipData,
  unionBoundsList,
} from '@spatialdata/core';
import {
  buildShapeFillColorByFeatureId,
  buildShapesPrebuiltData,
  PointsDataEngine,
  PointsLayer,
  type PointsLoadTarget,
  type PointsRenderResource,
  resolveShapeFeatureFromPick,
  resolveShapeTooltipFromPickInfo,
  resolveShapeTooltipRowIndex,
  type ShapeFeatureRenderDatum,
  type ShapeFeatureStateRuntime,
} from '@spatialdata/layers';
import type { Layer } from 'deck.gl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LabelsChannelDefaults } from './imageLoaderChannelDefaults';
import { renderLabelsLayer } from './renderers/labelsRenderer';
import { renderShapesLayer } from './renderers/shapesRenderer';
import { createNonOwningResolver } from './resolvers/nonOwningResolver';
import { ImagesResolver, LabelsResolver } from './resolvers/RasterResolvers';
import {
  getShapeFillColorAlpha,
  getShapeFillColorSignature,
  getStableShapeFeatureStateRuntime,
  type ShapeFillColorEntry,
  type ShapePrebuiltEntry,
  serializeHiddenIds,
} from './shapesProjection';
import type {
  AvailableElement,
  ChannelConfig,
  ElementsByType,
  LayerConfig,
  ShapesLayerConfig,
} from './types';
import { useVivLoaderRegistry } from './VivLoaderRegistry';
import {
  mergeVivImagePassthroughProps,
  type VivImagePassthroughOptions,
} from './vivImagePassthrough';

export interface ImageLoaderData {
  loader: unknown;
  colors?: [number, number, number][];
  contrastLimits?: [number, number][];
  channelsVisible?: boolean[];
  selections?: Array<Partial<{ z: number; c: number; t: number }>>;
  /** OME channel labels when available from element metadata. */
  channelNames?: string[];
  /** Present when loader exposes `labels` / `shape`: dimension lengths for z, c, t (omit axes that do not exist). */
  selectionAxisSizes?: Partial<Record<'z' | 'c' | 't', number>>;
}

export interface WorldBoundsCacheEntry {
  dataRef: unknown;
  transformRef: Matrix4;
  bounds: AxisAlignedBounds | null;
}

interface LoadedData {
  // Kind-owned data lives in its resolver/engine, not here: shapes geometry/tooltip/
  // fill-colour rows in `shapesResolver`, images in `imagesResolver`, labels in
  // `labelsResolver`, points in `pointsEngine`. What remains are vis-side render
  // projections keyed by layer id, plus the world-bounds cache.
  /**
   * Pre-built deck.gl `data` arrays keyed by **layer id** (not element key).
   * Each entry holds the O(n-features) array produced by `buildShapesPrebuiltData`
   * so that `getLayers()` never has to allocate it.  Invalidated only when
   * `hiddenFeatureIds` changes.
   */
  shapePrebuiltData: Map<string, ShapePrebuiltEntry>;
  /**
   * Per-layer table-column fill colour maps. Kept separate from element-keyed
   * geometry because two layers may render the same shapes with different
   * table columns.
   */
  shapeFillColorData: Map<string, ShapeFillColorEntry>;
  /**
   * World bounds keyed by element identity. Bounds depend on loaded geometry /
   * loader source and transform, not cosmetic layer props such as opacity.
   */
  worldBounds: Map<string, WorldBoundsCacheEntry>;
}

type ResourceLoadStatus = 'idle' | 'loading' | 'ready' | 'error';
type RasterSelection = Partial<{ z: number; c: number; t: number }>;

export interface LayerLoadState {
  geometry?: ResourceLoadStatus;
  image?: ResourceLoadStatus;
  tooltip?: ResourceLoadStatus;
}

export interface ImageLayerConfig {
  id: string;
  loader: unknown; // Viv PixelSource
  colors: [number, number, number][];
  contrastLimits: [number, number][];
  channelsVisible: boolean[];
  selections: Array<Partial<{ z: number; c: number; t: number }>>;
  modelMatrix?: Matrix4; // Transformation matrix for coordinate system alignment
  opacity?: number; // Layer opacity (0-1)
  visible?: boolean; // Whether layer is visible
  /** Merged extension / host Viv props for detailView.getLayers({ props }). */
  vivProps?: Record<string, unknown>;
}

/**
 * The labels channel defaults the properties panel reads. Now the exact shape the
 * `LabelsResolver` produces (`getLoadedData`) — tooltip metadata is a separate
 * resolver resource (`getTooltipMetadata`), no longer bundled into loaded data.
 */
export type LabelsLoaderData = LabelsChannelDefaults;

export interface ShapeFeaturePickEventData {
  elementKind: 'shapes';
  layerId: string;
  spatialElement: ShapesElement;
  featureId: string;
  featureIndex: number;
  rowIndex?: number;
  object: ShapeFeatureRenderDatum;
  tooltip?: SpatialFeatureTooltipData;
}

export interface LabelFeaturePickEventData {
  elementKind: 'labels';
  layerId: string;
  spatialElement: LabelsElement;
  featureId: string;
  labelId: string;
  channelIndex?: number;
  rowIndex?: number;
  object?: unknown;
  tooltip?: SpatialFeatureTooltipData;
}

export type SpatialFeaturePickEventData = ShapeFeaturePickEventData | LabelFeaturePickEventData;

interface UseLayerDataResult {
  /** Get deck.gl layers ready for rendering (shapes, points, etc.) */
  getLayers: (options?: { pickingEnabled?: boolean }) => Layer[];
  /** Get Viv layer props for image layers */
  getVivLayerProps: () => ImageLayerConfig[];
  /** Raw loaded image pipeline data (defaults) for the properties UI */
  getImageLayerLoadedData: (layerId: string) => ImageLoaderData | undefined;
  /** Raw loaded image data keyed by SpatialData element key. */
  getImageLoadedDataByElementKey: (elementKey: string) => ImageLoaderData | undefined;
  /** Raw loaded labels pipeline data (defaults) for the properties UI */
  getLabelsLayerLoadedData: (layerId: string) => LabelsLoaderData | undefined;
  /** Current load state for a given layer. */
  getLayerLoadState: (layerId?: string) => LayerLoadState | undefined;
  /** Whether a layer already has enough data to render. */
  hasRenderableLayerData: (layerId: string) => boolean;
  /** The live points data engine (the render path's single owner). Exposed so
   * the feature panel can subscribe to it directly for reactive catalog / scan
   * state via `PointsFeatureStateProvider`, instead of prop-drilling getters. */
  pointsEngine: PointsDataEngine;
  /** Resolve a points layer to the engine's load target `{ key, layerId,
   * element }`, or `undefined` when the layer isn't a resolvable points element.
   * Reuses the same element resolution the load path uses, so panel hooks read
   * the same cache keys the render writes. */
  resolvePointsTarget: (layerId: string) => PointsLoadTarget | undefined;
  /** Resolve a feature tooltip lazily from the picked row index. */
  getFeatureTooltip: (
    layerId: string,
    pickInfo: Pick<{ index?: number; object?: unknown }, 'index' | 'object'>
  ) => SpatialFeatureTooltipData | undefined;
  /** Resolve stable feature metadata from a picked deck object for runtime listeners. */
  getFeaturePickEvent: (
    layerId: string,
    pickInfo: Pick<{ index?: number; object?: unknown }, 'index' | 'object'>
  ) => SpatialFeaturePickEventData | undefined;
  /** Resolve stable shape feature metadata from a picked deck object. */
  getShapePickEvent: (
    layerId: string,
    pickInfo: Pick<{ index?: number; object?: unknown }, 'index' | 'object'>
  ) =>
    | {
        layerId: string;
        elementKey: string;
        featureId: string;
        featureIndex: number;
        rowIndex?: number;
        object: ShapeFeatureRenderDatum;
      }
    | undefined;
  /** Whether any layers are currently loading */
  isLoading: boolean;
  /** Whether any visible layer is still waiting on its first renderable resource. */
  isBlocking: boolean;
  /** Trigger a reload of data for a specific element */
  reloadElement: (type: string, key: string) => void;
  /** World-space axis-aligned bounds for one visible layer with loaded data, or null. */
  getWorldBoundsForLayer: (layerId: string) => AxisAlignedBounds | null;
  /** Union of bounds for all visible layers in order that have renderable data. */
  getWorldBoundsForVisibleLayers: () => AxisAlignedBounds | null;
}

function getLayerTooltipSignature(config: LayerConfig | undefined): string {
  return config && 'tooltipFields' in config ? getTooltipSignature(config.tooltipFields) : '';
}

function getPickedLabelObject(
  object: unknown
): { labelId: string; channelIndex?: number; object: unknown } | undefined {
  if (!object || typeof object !== 'object') {
    return undefined;
  }
  const rawLabelId = Reflect.get(object, 'labelId');
  const labelId = rawLabelId === undefined || rawLabelId === null ? '' : String(rawLabelId);
  if (!labelId) {
    return undefined;
  }
  const rawChannelIndex = Reflect.get(object, 'channelIndex');
  const channelIndex =
    typeof rawChannelIndex === 'number' && Number.isFinite(rawChannelIndex)
      ? rawChannelIndex
      : undefined;
  return { labelId, channelIndex, object };
}

function serializeRasterSelections(selections: RasterSelection[]): string {
  return selections
    .map((selection) => `z:${selection.z ?? ''}|c:${selection.c ?? ''}|t:${selection.t ?? ''}`)
    .join('\x00');
}

function getElementMapKey(config: Pick<LayerConfig, 'type' | 'elementKey'>): string {
  return `${config.type}:${config.elementKey}`;
}

function isLabelsAvailableElement(element: AvailableElement): element is Omit<
  AvailableElement,
  'type' | 'element'
> & {
  type: 'labels';
  element: LabelsElement;
} {
  return element.type === 'labels' && element.element.kind === 'labels';
}

function isShapesAvailableElement(element: AvailableElement): element is Omit<
  AvailableElement,
  'type' | 'element'
> & {
  type: 'shapes';
  element: ShapesElement;
} {
  return element.type === 'shapes' && element.element.kind === 'shapes';
}

function getWorldBoundsCacheKey(elem: AvailableElement): string {
  return `${elem.type}:${elem.key}`;
}

export function resolveLayerElement(
  layerId: string,
  config: LayerConfig | undefined,
  elementMap: Map<string, AvailableElement>
): AvailableElement | undefined {
  if (!config) return undefined;
  return elementMap.get(getElementMapKey(config)) ?? elementMap.get(layerId);
}

export function getCachedWorldBounds(
  cache: Map<string, WorldBoundsCacheEntry>,
  key: string,
  dataRef: unknown,
  transformRef: Matrix4,
  compute: () => AxisAlignedBounds | null
): AxisAlignedBounds | null {
  const cached = cache.get(key);
  if (cached && cached.dataRef === dataRef && cached.transformRef === transformRef) {
    return cached.bounds;
  }
  const bounds = compute();
  cache.set(key, { dataRef, transformRef, bounds });
  return bounds;
}

/**
 * Hook to manage async loading of layer data and produce deck.gl layers.
 *
 * This hook:
 * 1. Watches for changes to enabled layers
 * 2. Loads data for newly enabled layers
 * 3. Caches loaded data
 * 4. Produces deck.gl Layer instances with the loaded data
 */
export function useLayerData(
  layers: Record<string, LayerConfig>,
  layerOrder: string[],
  availableElements: ElementsByType,
  _coordinateSystem: string | null,
  spatialData?: SpatialData,
  vivPassthrough?: VivImagePassthroughOptions
): UseLayerDataResult {
  const { getOmeZarrMultiscalesData } = useVivLoaderRegistry();

  // Cache for loaded data
  const loadedDataRef = useRef<LoadedData>({
    shapePrebuiltData: new Map(),
    shapeFillColorData: new Map(),
    worldBounds: new Map(),
  });
  // Vis-side projection cache for coupling #1: the shapes resolver keeps raw
  // geometry and tooltip metadata independent, but the render/pick sites need the
  // geometry with `rowIndexByFeatureIndex` overwritten by the tooltip's
  // `tooltipRowIndices` (when present). Keyed by element key, memoised on
  // (raw identity, tooltipRowIndices identity) so a fresh merged object is not
  // produced per `getLayers()` call (that would be a deck teardown per frame).
  const mergedShapeRenderDataRef = useRef<
    Map<
      string,
      { raw: ShapesRenderData; tooltipRowIndices: Int32Array | undefined; merged: ShapesRenderData }
    >
  >(new Map());
  const stableSelectionArraysRef = useRef<
    Map<string, { signature: string; value: RasterSelection[] }>
  >(new Map());
  const stableShapeFeatureStateRef = useRef<
    Map<
      string,
      {
        signature: string;
        runtime: ShapeFeatureStateRuntime;
        fillColorEntry: ShapeFillColorEntry | undefined;
      }
    >
  >(new Map());

  // Mirror the latest `layers` into a ref. This is read both by async loaders
  // (which run well after commit) AND synchronously during render by
  // `hasRenderableLayerData` / the loaded-data getters consumed via context
  // (e.g. the "Center on layer" button's enablement, image/labels panels). It
  // must therefore be written during render, not in an effect: deferring it to a
  // commit-phase effect lets those render-time readers observe a stale config on
  // the render where a layer first appears, leaving derived UI (the Center
  // button) wrongly disabled with no follow-up render to correct it.
  const layersRef = useRef(layers);
  // eslint-disable-next-line react-hooks/refs -- intentional latest-`layers` mirror consumed during render, see comment above
  layersRef.current = layers;

  const [layerLoadStates, setLayerLoadStates] = useState<Record<string, LayerLoadState>>({});
  const [, setLoadedDataRevision] = useState(0);

  const notifyLoadedDataChanged = useCallback(() => {
    setLoadedDataRevision((revision) => revision + 1);
  }, []);

  // Build a map of element key -> AvailableElement for quick lookup. Memoised so it
  // only rebuilds when `availableElements` changes...
  const elementMapValue = useMemo(() => {
    const map = new Map<string, AvailableElement>();
    for (const type of ['images', 'shapes', 'points', 'labels'] as const) {
      for (const elem of availableElements[type]) {
        map.set(`${elem.type}:${elem.key}`, elem);
      }
    }
    return map;
  }, [availableElements]);
  // ...and mirrored into a stable ref so render-time consumers (e.g. the "Center on
  // layer" enablement via `hasRenderableLayerData`) and async loaders read the
  // current map without adding it — and its identity churn — to every dependency
  // array. Written during render, NOT in an effect: an effect-deferred write let
  // render-time readers observe a commit-stale map, which left the button disabled.
  const elementMap = useRef(elementMapValue);
  // eslint-disable-next-line react-hooks/refs -- intentional synchronous latest-value mirror consumed during render, see comment above
  elementMap.current = elementMapValue;

  const setLayerResourceStatus = useCallback(
    (layerId: string, resource: keyof LayerLoadState, status: ResourceLoadStatus) => {
      setLayerLoadStates((prev) => {
        const existing = prev[layerId] ?? {};
        if (existing[resource] === status) {
          return prev;
        }
        return {
          ...prev,
          [layerId]: {
            ...existing,
            [resource]: status,
          },
        };
      });
    },
    []
  );

  //--- to be removed from here?
  // Points loading/caching/resolution engine (LayerDataEngine step 1b). This
  // framework-agnostic engine (in @spatialdata/layers) owns the points preload
  // cache, the stable render-resource memo, and the async load orchestration
  // that previously lived as `useRef` state + a load-effect branch in this hook.
  // The hook is now a thin binding: it forwards status into `layerLoadStates`
  // and re-renders when the engine's cache settles.
  //
  // Held in `useState` with a lazy initializer (not a ref): the engine is a
  // stable value created once, so it is safe to read during render and to list
  // in effect/callback dependency arrays — unlike a ref, whose `current` must
  // not be read during render.
  const [pointsEngine] = useState(
    () =>
      new PointsDataEngine({
        onStatus: (layerId, status) => setLayerResourceStatus(layerId, 'geometry', status),
      })
  );

  // Shapes / images / labels Resource Resolvers (ADR 0004). Shapes lives in `core`,
  // images/labels in `vis` (next to Viv/avivatorish) — the store below holds only
  // `ResourceResolver`s and cannot tell which package each came from. Each rebuilds
  // when the dataset (`spatialData`) swaps because it closes over it; the store owns
  // their re-render subscription and disposal. Shapes forwards geometry/tooltip
  // status; the rasters forward loader status as `image` (fill and tooltip statuses
  // have never driven the blocking overlay).
  const shapesResolver = useMemo(
    () =>
      new ShapesResolver({
        spatialData,
        callbacks: {
          onStatus: (layerId, resource, status) => {
            if (resource === 'geometry' || resource === 'tooltip') {
              setLayerResourceStatus(layerId, resource, status);
            }
          },
        },
      }),
    [spatialData, setLayerResourceStatus]
  );
  const imagesResolver = useMemo(
    () =>
      new ImagesResolver({
        fetchMultiscales: getOmeZarrMultiscalesData,
        spatialData,
        onStatus: (layerId, _resource, status) => setLayerResourceStatus(layerId, 'image', status),
      }),
    [getOmeZarrMultiscalesData, spatialData, setLayerResourceStatus]
  );
  const labelsResolver = useMemo(
    () =>
      new LabelsResolver({
        fetchMultiscales: getOmeZarrMultiscalesData,
        spatialData,
        onStatus: (layerId, _resource, status) => setLayerResourceStatus(layerId, 'image', status),
      }),
    [getOmeZarrMultiscalesData, spatialData, setLayerResourceStatus]
  );

  // Points resolver, wrapped non-owning so the store can drive it without disposing
  // it. `pointsEngine` (the stable `useState` value the panels subscribe to) is its
  // real owner and outlives the store; the proxy is what keeps a store rebuild from
  // clearing the engine's cache and subscriptions. See `createNonOwningResolver` for
  // the full rationale. Keyed on the stable `pointsEngine`, so it never churns the
  // store on its own.
  const pointsResolverForStore = useMemo(
    () => createNonOwningResolver(pointsEngine.resourceResolver),
    [pointsEngine]
  );

  // The one reconcile loop over all four kinds (ADR 0004), replacing the per-kind
  // driving effects.
  //
  // Ownership model, in one place:
  //   • shapes/images/labels — created here (keyed on `spatialData`), OWNED by the
  //     store: it subscribes to them and disposes them. A dataset swap rebuilds them,
  //     which rebuilds the store, whose cleanup disposes the replaced instances.
  //   • points — owned by the stable `pointsEngine`; the store only borrows it through
  //     the non-owning proxy above and never disposes it.
  // So the store's identity tracks the raster/shapes resolvers; the points proxy is
  // stable and does not, on its own, force a rebuild.
  const store = useMemo(
    () =>
      new SpatialEntryStore({
        points: pointsResolverForStore,
        shapes: shapesResolver,
        images: imagesResolver,
        labels: labelsResolver,
      }),
    [pointsResolverForStore, shapesResolver, imagesResolver, labelsResolver]
  );

  // Re-render on any resolver cache mutation, and dispose the store — and with it the
  // shapes/images/labels resolvers it owns — when the store is replaced (dataset swap)
  // or the hook unmounts. The points proxy's `dispose` is a no-op, so `pointsEngine`
  // and its cache survive the swap. All four kinds' re-render notifications now route
  // through the store (the engine's own subscription is gone), including points via
  // the proxy → real resolver.
  //
  // NOTE: the consuming component (SpatialCanvasInner) must opt out of the React
  // Compiler (`'use no memo'`) — the compiler otherwise memoizes JSX built from these
  // resolver getters and never repaints on a late async settle.
  //
  // Caveat: `SpatialEntryStore` subscribes to its resolvers in its constructor, which
  // runs inside the `useMemo` above. Under React StrictMode's dev-only double-invoke a
  // discarded store instance leaks one listener on the (never-disposed) points
  // resolver per rebuild; each such listener only calls a dead store's `notify()`
  // (empty listener set), so it is inert. Harmless in production; noted so it is not
  // mistaken for a real leak.
  useEffect(() => {
    const unsubscribe = store.subscribe(notifyLoadedDataChanged);
    return () => {
      unsubscribe();
      store.dispose();
    };
  }, [store, notifyLoadedDataChanged]);

  // The single commit-phase driving effect. Build a `ResolveContext` for every
  // visible entry and hand them to the store: `reconcile` plans (pure) then loads,
  // and each resolver keeps today's in-flight dedup, so re-running per commit is
  // cheap. Points row-codes and the feature-index scan stay on the render-phase
  // engine calls in `getLayers` (Track A / the `plan()` migration — out of scope).
  //
  // Depends on `elementMapValue` (not just the `elementMap` ref) so it replans when
  // element resolution changes without `layers`/`store` changing — e.g. a coordinate
  // system switch that makes a previously unavailable element resolvable. The map is
  // memoised on `availableElements`, so this adds no per-render churn.
  useEffect(() => {
    const contexts: AnyResolveContext[] = [];
    for (const layerId of layerOrder) {
      const config = layers[layerId];
      if (!config?.visible) continue;
      const elem = resolveLayerElement(layerId, config, elementMapValue);
      if (!elem) continue;
      if (elem.type === 'shapes' && config.type === 'shapes') {
        contexts.push({
          entryId: layerId,
          elementKey: elem.key,
          kind: 'shapes',
          element: elem.element,
          config: {
            tooltipFields: config.tooltipFields,
            fillColorByColumn: config.fillColorByColumn,
          },
          transform: elem.transform,
        });
      } else if (elem.type === 'image' && config.type === 'image') {
        contexts.push({
          entryId: layerId,
          elementKey: elem.key,
          kind: 'images',
          element: elem.element,
          config: { channels: config.channels },
          transform: elem.transform,
        });
      } else if (elem.type === 'labels' && config.type === 'labels') {
        contexts.push({
          entryId: layerId,
          elementKey: elem.key,
          kind: 'labels',
          element: elem.element,
          config: { tooltipFields: config.tooltipFields, channels: config.channels },
          transform: elem.transform,
        });
      } else if (elem.type === 'points' && config.type === 'points') {
        // Only the preload is planned here; row-codes and the feature-index scan
        // stay on the render-phase engine calls in `getLayers` (Track A), so the
        // config deliberately carries just the memory cap.
        contexts.push({
          entryId: layerId,
          elementKey: elem.key,
          kind: 'points',
          element: elem.element,
          config: { pointsMemoryCap: resolvePointsMemoryCap(config.pointsMemoryCap) },
          transform: elem.transform,
        });
      }
    }
    void store.reconcile(contexts);
  }, [layers, layerOrder, store, elementMapValue]);

  // --- Shapes projection memos (Renderer Adapter side, kept in vis) -------------

  // Coupling #1: geometry with `rowIndexByFeatureIndex` patched by the tooltip's
  // `tooltipRowIndices`. Identity-stable per (raw, tooltipRowIndices) so deck does
  // not tear the layer down between frames. Returns raw identity when no patch.
  const getMergedShapeRenderData = useCallback(
    (key: string): ShapesRenderData | undefined => {
      const raw = shapesResolver.getRenderData(key);
      if (!raw) return undefined;
      const tooltipRowIndices = shapesResolver.getTooltipMetadata(key)?.tooltipRowIndices;
      const cached = mergedShapeRenderDataRef.current.get(key);
      if (cached && cached.raw === raw && cached.tooltipRowIndices === tooltipRowIndices) {
        return cached.merged;
      }
      const merged = tooltipRowIndices
        ? { ...raw, rowIndexByFeatureIndex: tooltipRowIndices }
        : raw;
      mergedShapeRenderDataRef.current.set(key, { raw, tooltipRowIndices, merged });
      return merged;
    },
    [shapesResolver]
  );

  // Pre-filtered feature arrays for deck, keyed by layer id. Lazy: (re)built only
  // when the merged render data identity or the `hiddenFeatureIds` signature moves.
  const getShapePrebuilt = useCallback(
    (layerId: string, renderData: ShapesRenderData, hiddenIds: string[] | undefined) => {
      const signature = serializeHiddenIds(hiddenIds);
      const cache = loadedDataRef.current.shapePrebuiltData;
      const cached = cache.get(layerId);
      if (cached && cached.signature === signature && cached.source === renderData) {
        return cached.prebuilt;
      }
      const prebuilt = buildShapesPrebuiltData(renderData, hiddenIds);
      cache.set(layerId, { prebuilt, signature, source: renderData });
      return prebuilt;
    },
    []
  );

  // Per-layer table-column fill-colour map, built from the resolver's raw rows.
  // Returns undefined (and drops any cached entry) when the layer has no fill
  // column, matching the old "no entry" state the feature-state helpers expect.
  const getShapeFillColorEntry = useCallback(
    (
      layerId: string,
      key: string,
      config: ShapesLayerConfig,
      renderData: ShapesRenderData
    ): ShapeFillColorEntry | undefined => {
      const fillColorByColumn = config.fillColorByColumn;
      const cache = loadedDataRef.current.shapeFillColorData;
      if (!fillColorByColumn?.columnName) {
        cache.delete(layerId);
        return undefined;
      }
      // No entry until the resolver's rows are actually loaded. The feature-state
      // runtime is memoised on a signature whose only fill term is this entry's
      // presence (`fillColorEntry?.signature`), so an eager empty-map entry with the
      // full signature would suppress the rebuild that makes fill colours appear when
      // the rows settle. Mirrors the old async path: entry exists only once loaded.
      const rows = shapesResolver.getFillColorRows(key);
      if (!rows) return undefined;
      const signature = getShapeFillColorSignature(config);
      const cached = cache.get(layerId);
      if (
        cached &&
        cached.signature === signature &&
        cached.rowsSource === rows &&
        cached.renderSource === renderData
      ) {
        return cached;
      }
      const entry: ShapeFillColorEntry = {
        signature,
        fillColorByFeatureId: buildShapeFillColorByFeatureId({
          featureIds: renderData.featureIds,
          rowIndexByFeatureIndex: renderData.rowIndexByFeatureIndex,
          column: rows.extraColumns?.[0],
          mode: fillColorByColumn.mode,
          alpha: getShapeFillColorAlpha(config),
        }),
        rowsSource: rows,
        renderSource: renderData,
      };
      cache.set(layerId, entry);
      return entry;
    },
    [shapesResolver]
  );

  const reloadElement = useCallback(
    (type: string, key: string) => {
      const loaded = loadedDataRef.current;
      if (type === 'shapes') {
        shapesResolver.evict(key);
        mergedShapeRenderDataRef.current.delete(key);
        loaded.worldBounds.delete(`shapes:${key}`);
        // Clear per-layer projection caches for every layer that maps to this key.
        for (const [layerId, config] of Object.entries(layersRef.current)) {
          if (config.type === 'shapes' && config.elementKey === key) {
            loaded.shapePrebuiltData.delete(layerId);
            loaded.shapeFillColorData.delete(layerId);
          }
        }
      } else if (type === 'points') {
        pointsEngine.evict(key);
        loaded.worldBounds.delete(`points:${key}`);
      } else if (type === 'image') {
        imagesResolver.evict(key);
        loaded.worldBounds.delete(`image:${key}`);
      } else if (type === 'labels') {
        labelsResolver.evict(key);
        loaded.worldBounds.delete(`labels:${key}`);
      }
      // The resolver/engine effects will pick up the missing data and reload
    },
    [pointsEngine, shapesResolver, imagesResolver, labelsResolver]
  );

  const getStableSelections = useCallback((key: string, selections: RasterSelection[]) => {
    const signature = serializeRasterSelections(selections);
    const cached = stableSelectionArraysRef.current.get(key);
    if (cached?.signature === signature) {
      return cached.value;
    }
    const value = selections.map((selection) => ({ ...selection }));
    stableSelectionArraysRef.current.set(key, { signature, value });
    return value;
  }, []);

  const hasRenderableLayerData = useCallback(
    (layerId: string): boolean => {
      const elem = resolveLayerElement(layerId, layersRef.current[layerId], elementMap.current);
      if (!elem) return false;
      if (elem.type === 'shapes') {
        return shapesResolver.getRenderData(elem.key) !== undefined;
      }
      if (elem.type === 'points') {
        return pointsEngine.hasData(elem.key);
      }
      if (elem.type === 'image') {
        return imagesResolver.getLoadedData(elem.key) !== undefined;
      }
      if (elem.type === 'labels') {
        return labelsResolver.getLoadedData(elem.key) !== undefined;
      }
      return false;
    },
    [pointsEngine, shapesResolver, imagesResolver, labelsResolver]
  );

  // --- Points feature state (filter panel) -----------------------------------
  // The panel no longer reads point state through prop-drilled getters. Instead
  // it subscribes to `pointsEngine` directly (via `PointsFeatureStateProvider`
  // + the `usePoints*` hooks), so its reactivity is self-contained and does not
  // depend on this hook's re-render or a `'use no memo'` escape hatch. All this
  // hook exposes is the engine and the element-key resolver the hooks need.
  const resolvePointsTarget = useCallback((layerId: string): PointsLoadTarget | undefined => {
    const elem = resolveLayerElement(layerId, layersRef.current[layerId], elementMap.current);
    if (elem?.type !== 'points') return undefined;
    return { key: elem.key, layerId, element: elem.element as PointsElement };
  }, []);

  const getWorldBoundsForLayer = useCallback(
    (layerId: string): AxisAlignedBounds | null => {
      try {
        const config = layers[layerId];
        const elem = resolveLayerElement(layerId, config, elementMap.current);
        if (!config?.visible || !elem) return null;
        const loaded = loadedDataRef.current;
        if (elem.type === 'shapes') {
          const renderData = getMergedShapeRenderData(elem.key);
          if (!renderData) return null;
          return getCachedWorldBounds(
            loaded.worldBounds,
            getWorldBoundsCacheKey(elem),
            renderData,
            elem.transform,
            () => {
              if (
                (renderData.geometryKind === 'circle' || renderData.geometryKind === 'point') &&
                renderData.circles
              ) {
                return boundsFromCircles(renderData.circles, elem.transform);
              }
              if (renderData.polygonBinary) {
                return boundsFromFlatPolygonPositions(
                  renderData.polygonBinary.positions,
                  elem.transform
                );
              }
              if (!renderData.polygons?.length) return null;
              return boundsFromPolygons(renderData.polygons, elem.transform);
            }
          );
        }
        if (elem.type === 'points') {
          const pointData = pointsEngine.getData(elem.key);
          if (!pointData) return null;
          return getCachedWorldBounds(
            loaded.worldBounds,
            getWorldBoundsCacheKey(elem),
            pointData,
            elem.transform,
            () => boundsFromPoints(pointData, elem.transform, false)
          );
        }
        if (elem.type === 'image') {
          // Physical-size bounds (coupling #2): the raster resolvers' own bounds omit
          // `getPhysicalSizeScalingMatrixFromMeta`, so the hook keeps the compute and
          // sources only the loader from the resolver.
          const loader = imagesResolver.getLoadedData(elem.key)?.loader;
          if (!loader) return null;
          const source = Array.isArray(loader) ? loader[0] : loader;
          if (!source || typeof source !== 'object') return null;
          return getCachedWorldBounds(
            loaded.worldBounds,
            getWorldBoundsCacheKey(elem),
            source,
            elem.transform,
            () => {
              const { width, height } = getImageSize(source as never);
              const physical = getPhysicalSizeScalingMatrixFromMeta(source);
              return boundsFromImagePixelExtents(width, height, elem.transform, physical);
            }
          );
        }
        if (elem.type === 'labels') {
          const loader = labelsResolver.getLoadedData(elem.key)?.loader;
          if (!loader) return null;
          const source = Array.isArray(loader) ? loader[0] : loader;
          if (!source || typeof source !== 'object') return null;
          return getCachedWorldBounds(
            loaded.worldBounds,
            getWorldBoundsCacheKey(elem),
            source,
            elem.transform,
            () => {
              const { width, height } = getImageSize(source as never);
              const physical = getPhysicalSizeScalingMatrixFromMeta(source);
              return boundsFromImagePixelExtents(width, height, elem.transform, physical);
            }
          );
        }
        return null;
      } catch (err) {
        console.warn(`[useLayerData] getWorldBoundsForLayer failed for ${layerId}`, err);
        return null;
      }
    },
    [layers, pointsEngine, getMergedShapeRenderData, imagesResolver, labelsResolver]
  );

  const getWorldBoundsForVisibleLayers = useCallback((): AxisAlignedBounds | null => {
    const list: AxisAlignedBounds[] = [];
    for (const layerId of layerOrder) {
      const config = layers[layerId];
      if (!config?.visible) continue;
      const b = getWorldBoundsForLayer(layerId);
      if (b) list.push(b);
    }
    return unionBoundsList(list);
  }, [layerOrder, layers, getWorldBoundsForLayer]);

  const getLayers = useCallback(
    (options?: { pickingEnabled?: boolean }): Layer[] => {
      // When the camera is moving we disable shape picking (autoHighlight + hover)
      // to avoid deck re-rendering the full shape geometry into the picking buffer
      // on every pointer move. Defaults to enabled.
      const pickingEnabled = options?.pickingEnabled ?? true;
      const deckLayers: Layer[] = [];

      for (const layerId of layerOrder) {
        const config = layers[layerId];
        if (!config?.visible) continue;

        const elem = resolveLayerElement(layerId, config, elementMap.current);
        if (!elem) continue;

        if (config.type === 'shapes') {
          const renderData = getMergedShapeRenderData(elem.key);
          if (renderData) {
            const fillColorEntry = getShapeFillColorEntry(layerId, elem.key, config, renderData);
            const layer = renderShapesLayer({
              element: elem.element as ShapesElement,
              id: layerId,
              modelMatrix: elem.transform,
              opacity: config.opacity,
              visible: config.visible,
              fillColor: config.fillColor,
              strokeColor: config.strokeColor,
              strokeWidth: config.strokeWidth,
              strokeWidthUnits: config.strokeWidthUnits,
              strokeWidthMinPixels: config.strokeWidthMinPixels,
              strokeWidthMaxPixels: config.strokeWidthMaxPixels,
              featureStateRuntime: getStableShapeFeatureStateRuntime(
                layerId,
                config,
                fillColorEntry,
                stableShapeFeatureStateRef.current
              ),
              renderData,
              prebuilt: getShapePrebuilt(
                layerId,
                renderData,
                config.featureState?.hiddenFeatureIds
              ),
              pickingEnabled,
            });
            // The binary polygon path returns [fill, outline]; flatten so both
            // reach deck as siblings (the outline draws over the fill).
            if (Array.isArray(layer)) deckLayers.push(...layer);
            else if (layer) deckLayers.push(layer);
          }
        } else if (config.type === 'points') {
          const element = elem.element as PointsElement;
          const featureCodes = config.featureCodes;
          const selectionActive = featureCodes !== undefined && featureCodes.length > 0;

          // Feature-index render scan: when a selection is active, load the WHOLE
          // dataset's matching points (footer stats skip the row groups a selected
          // feature can't live in), so features outside the resident preload window
          // still render. The scan is idempotent per selection; kicking it here is a
          // no-op once resident/in-flight. On settle it notifies → re-render → the
          // matched resource appears below. `getMatchingResource` returns the LAST
          // completed matched batch, so a selection change keeps showing the prior
          // selection's points until the new scan settles (no blank mid-scan).
          //
          // Gated on scan capability: an authoritative code column (footer stats
          // skip row groups) OR a dictionary-only element with a catalog loaded —
          // there the scan reads the whole file and matches each row's feature_name
          // against the catalog's code space, so a selected gene's points render
          // even when they fall outside the resident preload window. Before any
          // catalog loads (no shared code space) there is nothing to match names
          // against, so it falls through to resident in-memory filtering.
          const canFeatureScan = pointsEngine.supportsFeatureScan(elem.key);
          let matchingResource: PointsRenderResource | null = null;
          let partialResource: PointsRenderResource | null = null;
          if (selectionActive && canFeatureScan) {
            void pointsEngine.ensureMatchingFeaturesLoaded(
              { key: elem.key, layerId, element },
              featureCodes,
              resolvePointsMemoryCap(config.pointsMemoryCap)
            );
            matchingResource = pointsEngine.getMatchingResource(element, elem.key);
            // The in-flight scan's growing buffer (all matched chunks so far), drawn
            // as an extra overlay sub-layer below so the base (resident preview /
            // prior matched batch) stays visible while points progressively fill in.
            partialResource = pointsEngine.getMatchingPartialResource(element, elem.key);
          }

          if (matchingResource) {
            // The matched batch covers the selection (or a superset of it, when the
            // selection just shrank). Pass the batch's per-row codes + the current
            // selection so the layer filters IN MEMORY down to the selected codes —
            // this is what makes removing a feature a free filter instead of a
            // re-scan. When the selection equals what was scanned, skip the filter
            // (render the batch whole); the batch's own codes still drive colour.
            const matchedRowCodes = pointsEngine.getMatchingRowFeatureCodes(elem.key);
            const coveredSize = pointsEngine.getLoadedMatchingFeatureCodes(elem.key)?.size ?? 0;
            const filterMatched = featureCodes !== undefined && featureCodes.length < coveredSize;
            deckLayers.push(
              new PointsLayer({
                id: layerId,
                resource: matchingResource,
                modelMatrix: elem.transform,
                opacity: config.opacity,
                visible: config.visible,
                pointSize: config.pointSize ?? 1,
                ...(filterMatched ? { featureCodes } : {}),
                ...(matchedRowCodes ? { preloadedFeatureCodes: matchedRowCodes } : {}),
                ...(config.color ? { color: config.color } : {}),
                ...(config.colorByFeature ? { colorByFeature: true } : {}),
              })
            );
          } else {
            // Resident batch: the default view (no selection), and an instant preview
            // of the resident subset while the feature-index scan is still running.
            // The engine returns a STABLE render resource (memoized by signature), so
            // re-running getLayers every pan/zoom frame reuses the same loader
            // identity and the composite does not reset its batch (no flashing).
            const resource = pointsEngine.getResource(element, elem.key);
            if (resource) {
              const filterActive = featureCodes !== undefined;
              // Row codes are needed to filter by feature AND to colour by feature.
              // Colour-by-feature applies even with no filter ("all features"), so
              // load/pass the codes whenever either is on — not just when filtering.
              const needsRowCodes = filterActive || config.colorByFeature === true;
              if (needsRowCodes && !pointsEngine.hasRowFeatureCodes(elem.key)) {
                void pointsEngine.ensureRowFeatureCodes({ key: elem.key, layerId, element });
              }
              const preloadedFeatureCodes = needsRowCodes
                ? pointsEngine.getRowFeatureCodes(elem.key)
                : undefined;
              deckLayers.push(
                new PointsLayer({
                  id: layerId,
                  resource,
                  modelMatrix: elem.transform,
                  opacity: config.opacity,
                  visible: config.visible,
                  // Legacy renderPointsLayer defaulted radius to 1px; preserve that
                  // for parity (the composite's own default is smaller).
                  pointSize: config.pointSize ?? 1,
                  ...(config.color ? { color: config.color } : {}),
                  ...(config.colorByFeature ? { colorByFeature: true } : {}),
                  ...(featureCodes ? { featureCodes } : {}),
                  ...(preloadedFeatureCodes ? { preloadedFeatureCodes } : {}),
                })
              );
            }
          }

          // Overlay the in-flight scan's growing buffer as a SEPARATE sub-layer on
          // top of whichever base layer was pushed above, so the base doesn't blank
          // while points progressively fill in. Distinct id so deck keeps them as two
          // layers. Filter it to the CURRENT selection with the partial's own per-row
          // codes — mirroring the settled matched layer — so a feature deselected
          // mid-scan stops rendering immediately instead of lingering until settle.
          if (partialResource) {
            const partialRowCodes = pointsEngine.getMatchingPartialRowFeatureCodes(elem.key);
            deckLayers.push(
              new PointsLayer({
                id: `${layerId}__partial`,
                resource: partialResource,
                modelMatrix: elem.transform,
                opacity: config.opacity,
                visible: config.visible,
                pointSize: config.pointSize ?? 1,
                ...(featureCodes ? { featureCodes } : {}),
                ...(partialRowCodes ? { preloadedFeatureCodes: partialRowCodes } : {}),
                ...(config.color ? { color: config.color } : {}),
                ...(config.colorByFeature ? { colorByFeature: true } : {}),
              })
            );
          }
        } else if (config.type === 'labels') {
          const labelsData = labelsResolver.getLoadedData(elem.key);
          if (labelsData) {
            const ch = config.channels;
            const rawSelections =
              ch?.selections && ch.selections.length > 0
                ? ch.selections
                : (labelsData.selections ?? [{}]);
            const selections =
              labelsData.selectionAxisSizes !== undefined
                ? clampVivSelectionsToAxes(rawSelections, labelsData.selectionAxisSizes)
                : rawSelections;
            const stableSelections = getStableSelections(`labels:${layerId}`, selections);

            // Fallbacks mirror `buildLabelsChannelDefaults`: the resolver always
            // populates these, but its `LabelsChannelDefaults` types them optional.
            const layer = renderLabelsLayer({
              id: layerId,
              loader: labelsData.loader,
              modelMatrix: elem.transform,
              opacity: config.opacity,
              visible: config.visible,
              channelColors:
                ch?.colors && ch.colors.length > 0
                  ? ch.colors
                  : (labelsData.colors ?? [[255, 255, 255]]),
              channelsVisible:
                ch?.channelsVisible && ch.channelsVisible.length > 0
                  ? ch.channelsVisible
                  : (labelsData.channelsVisible ?? [true]),
              channelOpacities:
                ch?.channelOpacities && ch.channelOpacities.length > 0
                  ? ch.channelOpacities
                  : (labelsData.channelOpacities ?? [0.18]),
              channelOutlineOpacities:
                ch?.channelOutlineOpacities && ch.channelOutlineOpacities.length > 0
                  ? ch.channelOutlineOpacities
                  : (labelsData.channelOutlineOpacities ?? [0.95]),
              channelsFilled:
                ch?.channelsFilled && ch.channelsFilled.length > 0
                  ? ch.channelsFilled
                  : (labelsData.channelsFilled ?? [true]),
              channelStrokeWidths:
                ch?.channelStrokeWidths && ch.channelStrokeWidths.length > 0
                  ? ch.channelStrokeWidths
                  : (labelsData.channelStrokeWidths ?? [1.5]),
              selections: stableSelections,
            });
            if (layer) deckLayers.push(layer);
          }
        }
        // Image layers are handled separately via getVivLayerProps()
      }

      return deckLayers;
    },
    [
      layers,
      layerOrder,
      getStableSelections,
      pointsEngine,
      getMergedShapeRenderData,
      getShapeFillColorEntry,
      getShapePrebuilt,
      labelsResolver,
    ]
  );

  const getImageLayerLoadedData = useCallback(
    (layerId: string): ImageLoaderData | undefined => {
      const elem = resolveLayerElement(layerId, layersRef.current[layerId], elementMap.current);
      if (elem?.type !== 'image') return undefined;
      return imagesResolver.getLoadedData(elem.key);
    },
    [imagesResolver]
  );

  const getImageLoadedDataByElementKey = useCallback(
    (elementKey: string): ImageLoaderData | undefined => {
      return imagesResolver.getLoadedData(elementKey);
    },
    [imagesResolver]
  );

  const getLabelsLayerLoadedData = useCallback(
    (layerId: string): LabelsLoaderData | undefined => {
      const elem = resolveLayerElement(layerId, layersRef.current[layerId], elementMap.current);
      if (elem?.type !== 'labels') return undefined;
      return labelsResolver.getLoadedData(elem.key);
    },
    [labelsResolver]
  );

  const getLayerLoadState = useCallback(
    (layerId?: string): LayerLoadState | undefined => {
      if (layerId === undefined) return undefined;
      return layerLoadStates[layerId];
    },
    [layerLoadStates]
  );

  const getFeatureTooltip = useCallback(
    (
      layerId: string,
      pickInfo: Pick<{ index?: number; object?: unknown }, 'index' | 'object'>
    ): SpatialFeatureTooltipData | undefined => {
      const elem = resolveLayerElement(layerId, layersRef.current[layerId], elementMap.current);
      if (!elem) {
        return undefined;
      }

      const elementContext = {
        elementKey: elem.key,
        elementType: elem.type,
        layerId,
      };

      if (isLabelsAvailableElement(elem)) {
        const pickedLabel = getPickedLabelObject(pickInfo.object);
        if (!pickedLabel) {
          return undefined;
        }
        const { labelId } = pickedLabel;

        const labelsTooltip = labelsResolver.getTooltipMetadata(elem.key);
        const config = layersRef.current[layerId];
        const items: Array<{ label: string; value: string }> = [{ label: 'id', value: labelId }];

        if (
          config?.type === 'labels' &&
          (config.tooltipFields?.length ?? 0) > 0 &&
          labelsTooltip?.tooltipFields &&
          labelsTooltip.tooltipColumns &&
          labelsTooltip.tooltipRowIndexByFeatureId &&
          getLayerTooltipSignature(config) === (labelsTooltip.tooltipSignature ?? '')
        ) {
          const rowIndex = labelsTooltip.tooltipRowIndexByFeatureId.get(labelId);
          if (rowIndex !== undefined && rowIndex >= 0) {
            const tooltipItems = resolveTooltipItems(
              labelsTooltip.tooltipFields,
              labelsTooltip.tooltipColumns,
              rowIndex
            );
            items.push(...tooltipItems);
          }
        }

        return attachTooltipElementContext(
          {
            title: labelId,
            items,
          },
          elementContext
        );
      }

      if (!isShapesAvailableElement(elem)) {
        return undefined;
      }

      const config = layersRef.current[layerId];
      const tooltipMetadata = shapesResolver.getTooltipMetadata(elem.key);
      const renderData = getMergedShapeRenderData(elem.key);
      const hiddenIds =
        config?.type === 'shapes' ? config.featureState?.hiddenFeatureIds : undefined;
      const prebuilt = renderData ? getShapePrebuilt(layerId, renderData, hiddenIds) : undefined;
      const feature = resolveShapeFeatureFromPick(pickInfo, prebuilt);
      if (!feature) {
        return undefined;
      }

      if (
        tooltipMetadata?.tooltipFields &&
        tooltipMetadata.tooltipColumns &&
        getLayerTooltipSignature(config) === (tooltipMetadata.tooltipSignature ?? '')
      ) {
        const tooltip = resolveShapeTooltipFromPickInfo(
          {
            tooltipFields: tooltipMetadata.tooltipFields,
            tooltipColumns: tooltipMetadata.tooltipColumns,
          },
          pickInfo,
          {
            tooltipRowIndexByFeatureId: tooltipMetadata.tooltipRowIndexByFeatureId,
            tooltipRowIndices: tooltipMetadata.tooltipRowIndices,
            rowIndexByFeatureIndex: renderData?.rowIndexByFeatureIndex,
          },
          prebuilt
        );
        if (tooltip) {
          return attachTooltipElementContext(tooltip, elementContext);
        }
      }

      return attachTooltipElementContext(
        {
          title: feature.featureId,
          items: [{ label: 'feature_id', value: feature.featureId }],
        },
        elementContext
      );
    },
    [shapesResolver, labelsResolver, getMergedShapeRenderData, getShapePrebuilt]
  );

  const getShapePickEvent = useCallback(
    (layerId: string, pickInfo: Pick<{ index?: number; object?: unknown }, 'index' | 'object'>) => {
      const elem = resolveLayerElement(layerId, layersRef.current[layerId], elementMap.current);
      if (elem?.type !== 'shapes') {
        return undefined;
      }
      const config = layersRef.current[layerId];
      const renderData = getMergedShapeRenderData(elem.key);
      const hiddenIds =
        config?.type === 'shapes' ? config.featureState?.hiddenFeatureIds : undefined;
      const prebuilt = renderData ? getShapePrebuilt(layerId, renderData, hiddenIds) : undefined;
      const feature = resolveShapeFeatureFromPick(pickInfo, prebuilt);
      if (!feature) {
        return undefined;
      }
      const tooltipMetadata = shapesResolver.getTooltipMetadata(elem.key);
      const rowIndex =
        resolveShapeTooltipRowIndex(feature, {
          tooltipRowIndexByFeatureId: tooltipMetadata?.tooltipRowIndexByFeatureId,
          tooltipRowIndices: tooltipMetadata?.tooltipRowIndices,
          rowIndexByFeatureIndex: renderData?.rowIndexByFeatureIndex,
        }) ?? feature.rowIndex;
      return {
        layerId,
        elementKey: elem.key,
        featureId: feature.featureId,
        featureIndex: feature.featureIndex,
        rowIndex,
        object: feature,
      };
    },
    [shapesResolver, getMergedShapeRenderData, getShapePrebuilt]
  );

  const getFeaturePickEvent = useCallback(
    (
      layerId: string,
      pickInfo: Pick<{ index?: number; object?: unknown }, 'index' | 'object'>
    ): SpatialFeaturePickEventData | undefined => {
      const elem = resolveLayerElement(layerId, layersRef.current[layerId], elementMap.current);
      if (!elem) {
        return undefined;
      }

      if (isLabelsAvailableElement(elem)) {
        const pickedLabel = getPickedLabelObject(pickInfo.object);
        if (!pickedLabel) {
          return undefined;
        }
        const rowIndex = labelsResolver
          .getTooltipMetadata(elem.key)
          ?.tooltipRowIndexByFeatureId?.get(pickedLabel.labelId);
        return {
          elementKind: 'labels',
          layerId,
          spatialElement: elem.element,
          featureId: pickedLabel.labelId,
          labelId: pickedLabel.labelId,
          channelIndex: pickedLabel.channelIndex,
          rowIndex,
          object: pickedLabel.object,
          tooltip: getFeatureTooltip(layerId, pickInfo),
        };
      }

      if (!isShapesAvailableElement(elem)) {
        return undefined;
      }

      const shapeEvent = getShapePickEvent(layerId, pickInfo);
      if (!shapeEvent) {
        return undefined;
      }
      return {
        elementKind: 'shapes',
        layerId: shapeEvent.layerId,
        spatialElement: elem.element,
        featureId: shapeEvent.featureId,
        featureIndex: shapeEvent.featureIndex,
        rowIndex: shapeEvent.rowIndex,
        object: shapeEvent.object,
        tooltip: getFeatureTooltip(layerId, pickInfo),
      };
    },
    [getFeatureTooltip, getShapePickEvent, labelsResolver]
  );

  const getVivLayerProps = useCallback((): ImageLayerConfig[] => {
    const vivProps: ImageLayerConfig[] = [];
    const passthrough = vivPassthrough;

    for (const layerId of layerOrder) {
      const config = layers[layerId];
      if (!config?.visible || config.type !== 'image') continue;

      const elem = resolveLayerElement(layerId, config, elementMap.current);
      if (elem?.type !== 'image') continue;

      const imageData = imagesResolver.getLoadedData(elem.key);
      if (!imageData) continue; // Skip if loader not ready yet

      const ch = config.channels;
      const colors =
        ch?.colors && ch.colors.length > 0 ? ch.colors : imageData.colors || [[255, 255, 255]];
      const contrastLimits =
        ch?.contrastLimits && ch.contrastLimits.length > 0
          ? ch.contrastLimits
          : imageData.contrastLimits || [[0, 65535]];
      const channelsVisible =
        ch?.channelsVisible && ch.channelsVisible.length > 0
          ? ch.channelsVisible
          : imageData.channelsVisible || [true];
      const rawSelections =
        ch?.selections && ch.selections.length > 0 ? ch.selections : imageData.selections || [{}];
      const axisSizes = imageData.selectionAxisSizes;
      const selections =
        axisSizes !== undefined
          ? clampVivSelectionsToAxes(rawSelections, axisSizes)
          : rawSelections;
      const stableSelections = getStableSelections(`image:${layerId}`, selections);

      const mergedChannels: ChannelConfig = {
        channelIds: ch?.channelIds,
        colors,
        contrastLimits,
        channelsVisible,
        selections: stableSelections,
      };

      const resolverCtx = {
        layerId: config.id,
        elementKey: elem.key,
        channelCount: colors.length,
        loader: imageData.loader,
        channels: mergedChannels,
      };

      const resolvedProps = passthrough?.vivImagePropsResolver?.(resolverCtx);
      const resolvedExtensions = passthrough?.vivImageExtensionResolver?.(resolverCtx);
      const mergedVivProps = mergeVivImagePassthroughProps(
        config.vivLayerProps,
        resolvedProps,
        resolvedExtensions,
        passthrough?.vivImageExtensions
      );

      vivProps.push({
        id: config.id,
        loader: imageData.loader,
        colors,
        contrastLimits,
        channelsVisible,
        selections: stableSelections,
        modelMatrix: elem.transform, // Apply coordinate transformation
        opacity: config.opacity,
        visible: config.visible,
        vivProps: mergedVivProps,
      });
    }

    return vivProps;
  }, [layers, layerOrder, getStableSelections, vivPassthrough, imagesResolver]);

  const isLoading = useMemo(
    () =>
      Object.values(layerLoadStates).some((state) =>
        Object.values(state).some((status) => status === 'loading')
      ),
    [layerLoadStates]
  );

  const isBlocking = useMemo(
    () =>
      // `hasRenderableLayerData` consults `loadedDataRef`, an imperatively
      // maintained cache of already-loaded layer data. Reading it during render
      // is intentional here: the blocking overlay must distinguish a layer that
      // is loading for the first time (block) from one that is refreshing but
      // already has data to show (don't block), and that distinction only lives
      // in the cache. Freshness is guaranteed because `layerLoadStates` (a real
      // state value in this memo's deps) changes in lockstep with every load,
      // forcing this memo to recompute. Lifting the cache to state/useSyncExternalStore
      // would satisfy the rule but defeats the performance reason the ref exists.
      // eslint-disable-next-line react-hooks/refs -- intentional external-store read, see comment above
      layerOrder.some((layerId) => {
        const config = layers[layerId];
        if (!config?.visible) return false;
        const state = layerLoadStates[layerId];
        if (!state) return false;
        if (config.type === 'image') {
          return state.image === 'loading' && !hasRenderableLayerData(layerId);
        }
        if (config.type === 'labels') {
          return state.image === 'loading' && !hasRenderableLayerData(layerId);
        }
        if (config.type === 'points') {
          return state.geometry === 'loading' && !hasRenderableLayerData(layerId);
        }
        // Shapes load non-blocking: geometry refines an already-painted canvas and
        // never gates first paint (`ShapesResolver.blockingResources` is empty).
        // `getLayers` skips a shapes layer until its geometry is ready, and the
        // non-modal `isLoading` indicator covers the wait.
        if (config.type === 'shapes') return false;
        return false;
      }),
    [layerLoadStates, layerOrder, layers, hasRenderableLayerData]
  );

  return {
    getLayers,
    getVivLayerProps,
    getImageLayerLoadedData,
    getImageLoadedDataByElementKey,
    getLabelsLayerLoadedData,
    getLayerLoadState,
    hasRenderableLayerData,
    pointsEngine,
    resolvePointsTarget,
    getFeatureTooltip,
    getFeaturePickEvent,
    getShapePickEvent,
    isLoading,
    isBlocking,
    reloadElement,
    getWorldBoundsForLayer,
    getWorldBoundsForVisibleLayers,
  };
}
