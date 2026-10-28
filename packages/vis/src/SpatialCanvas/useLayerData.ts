/**
 * Hook for loading and caching layer data
 *
 * Handles async loading of geometry data (shapes, points) and manages
 * loading state for each layer.
 */

import type { Layer } from '@deck.gl/core';
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
  pointsTilingEnabled,
  resolveFeatureSelectionCodes,
  resolvePointsMemoryCap,
  resolveTooltipItems,
  type ShapesElement,
  type ShapesRenderData,
  ShapesResolver,
  type SpatialData,
  SpatialEntryStore,
  type SpatialFeatureTooltipData,
  transformAxisAlignedBounds,
  unionBoundsList,
} from '@spatialdata/core';
import {
  createTileDebugStore,
  featureFilterAwaitingRowCodes,
  formatPointsTileDebugTooltip,
  formatPointsTooltip,
  isPointsPickObject,
  isPointsTileDebugPickObject,
  LabelsRendererAdapter,
  PointsDataEngine,
  PointsLayer,
  type PointsLoadTarget,
  type PointsPickObject,
  type PointsRenderResource,
  resolveShapeFeatureFromPick,
  resolveShapeTooltipFromPickInfo,
  resolveShapeTooltipRowIndex,
  type ShapeFeatureRenderDatum,
  ShapesRendererAdapter,
  type TileDebugStore,
} from '@spatialdata/layers';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type EntryStatus, EntryStatusCache } from './entryStatus';
import { createFeatureColorStabilizer, type FeatureColorResolver } from './featureColorResolver';
import type { LabelsChannelDefaults } from './imageLoaderChannelDefaults';
import {
  aggregatePointsTileLoadProgress,
  isPointsTileLoading,
  type PointsTileLoadProgress,
  pointsTileLoadProgressFromStore,
  tileDebugSignature,
} from './pointsTileProgress';
import { describeResolveInputs } from './resolveInputs';
import { createNonOwningResolver } from './resolvers/nonOwningResolver';
import { ImagesResolver, LabelsResolver } from './resolvers/RasterResolvers';
import type {
  AvailableElement,
  ChannelConfig,
  ElementsByType,
  LayerConfig,
  PointsLayerConfig,
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
  // `labelsResolver`, points in `pointsEngine`. The render projections built on top
  // of them live in their Renderer Adapters (`shapesAdapter`, `labelsAdapter`,
  // `pointsEngine`'s own) — ADR 0004 §4. What remains here is the world-bounds cache.
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

/**
 * A picked point. No `rowIndex`: a points element carries no table association, and
 * the index deck reports is a row in the DRAWN BATCH (one tile, on the tiled path) —
 * it identifies nothing durable, so it is named `pointIndex` to say so. `featureId`
 * is the feature NAME, which is what identifies a point to a reader, once the
 * element's feature catalog has resolved its code.
 */
export interface PointsFeaturePickEventData {
  elementKind: 'points';
  layerId: string;
  spatialElement: PointsElement;
  featureId?: string;
  featureCode?: number;
  pointIndex: number;
  /** Position in the element's own coordinate space, before its transform. */
  position: [number, number, number];
  object: PointsPickObject;
  tooltip?: SpatialFeatureTooltipData;
}

export type SpatialFeaturePickEventData =
  | ShapeFeaturePickEventData
  | LabelFeaturePickEventData
  | PointsFeaturePickEventData;

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
  /**
   * Why a layer failed and what is degraded about it, or `undefined` when it has
   * nothing to report. Identity-stable until the status changes.
   */
  getEntryStatus: (layerId: string) => EntryStatus | undefined;
  /**
   * Re-run a layer's failed loads. Offer it for errors with `retryable: true`; the
   * others fail the same way again. Settles once the retried loads have.
   */
  retryEntry: (layerId: string) => Promise<void>;
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
  /**
   * Set (or clear with `null`) the label drawn as hovered.
   *
   * Runtime render state, deliberately not part of the Render Stack: it changes on
   * every pointer move and would be meaningless in a saved view. It reaches the
   * shader as a uniform, so a hover re-uploads neither the colour LUT nor the
   * tiles. Passing an unchanged value is free — no re-render is scheduled.
   */
  setHoveredLabel: (next: { layerId: string; labelId: number } | null) => void;
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

function isPointsAvailableElement(element: AvailableElement): element is Omit<
  AvailableElement,
  'type' | 'element'
> & {
  type: 'points';
  element: PointsElement;
} {
  return element.type === 'points' && element.element.kind === 'points';
}

function getWorldBoundsCacheKey(elem: AvailableElement): string {
  return `${elem.type}:${elem.key}`;
}

/**
 * Id suffix of the overlay that draws the in-flight scan's growing buffer (see the
 * `partialResource` layer in `getLayers`). It is a second deck layer for ONE config,
 * so a pick on it carries an id nothing is keyed by.
 */
const PARTIAL_LAYER_SUFFIX = '__partial';

export function partialLayerId(layerId: string): string {
  return `${layerId}${PARTIAL_LAYER_SUFFIX}`;
}

/**
 * The config's layer id for an id a pick came through — the scan overlay's own id
 * maps back to the layer it is overlaying.
 *
 * Without this, hovering a point WHILE a feature scan is running resolves no
 * element and the tooltip silently shows nothing, for as long as the scan runs.
 */
export function layerIdForPick(layerId: string): string {
  return layerId.endsWith(PARTIAL_LAYER_SUFFIX)
    ? layerId.slice(0, -PARTIAL_LAYER_SUFFIX.length)
    : layerId;
}

export function resolveLayerElement(
  layerId: string,
  config: LayerConfig | undefined,
  elementMap: Map<string, AvailableElement>
): AvailableElement | undefined {
  if (!config) return undefined;
  return elementMap.get(getElementMapKey(config)) ?? elementMap.get(layerId);
}

/**
 * The `ResolveContext` for one layer: what the reconcile effect plans from, and
 * what a status read or a retry must pass so it addresses the same entry.
 */
function buildResolveContext(
  layerId: string,
  config: LayerConfig,
  elem: AvailableElement,
  pointsEngine: PointsDataEngine
): AnyResolveContext | undefined {
  if (elem.type === 'shapes' && config.type === 'shapes') {
    return {
      entryId: layerId,
      elementKey: elem.key,
      kind: 'shapes',
      element: elem.element,
      config: {
        tooltipFields: config.tooltipFields,
        fillColorByColumn: config.fillColorByColumn,
      },
      transform: elem.transform,
    };
  }
  if (elem.type === 'image' && config.type === 'image') {
    return {
      entryId: layerId,
      elementKey: elem.key,
      kind: 'images',
      element: elem.element,
      config: { channels: config.channels },
      transform: elem.transform,
    };
  }
  if (elem.type === 'labels' && config.type === 'labels') {
    return {
      entryId: layerId,
      elementKey: elem.key,
      kind: 'labels',
      element: elem.element,
      config: {
        tooltipFields: config.tooltipFields,
        channels: config.channels,
        fillColorByColumn: config.fillColorByColumn,
      },
      transform: elem.transform,
    };
  }
  if (elem.type === 'points' && config.type === 'points') {
    // The full points config drives planning (Track A): `plan()` emits the
    // preload, and — once the preload makes a scan possible — the row-codes and
    // feature-index scan tasks from `featureCodes`/`colorByFeature`. These used
    // to be kicked imperatively from `getLayers` during render.
    return {
      entryId: layerId,
      elementKey: elem.key,
      kind: 'points',
      element: elem.element,
      config: {
        pointsMemoryCap: resolvePointsMemoryCap(config.pointsMemoryCap),
        // Names are the durable selection; resolve them against the settled
        // catalog so everything downstream keeps working in codes.
        ...(() => {
          const codes = resolveFeatureSelectionCodes(
            config,
            pointsEngine.getFeatureCatalog(elem.key)
          );
          return codes ? { featureCodes: codes } : {};
        })(),
        ...(config.colorByFeature ? { colorByFeature: true } : {}),
        // D5: opting in makes `plan()` probe for a Morton artifact before it
        // commits to a full-table preload, and render viewport tiles when there
        // is one. Off by default; an element that cannot be tiled preloads either
        // way.
        ...(config.pointsTiling ? { pointsTiling: config.pointsTiling } : {}),
      },
      transform: elem.transform,
    };
  }
  return undefined;
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
/**
 * Does this layer draw through the Morton tile path (D5)?
 *
 * BOTH halves are required. `isTiled` is a fact about the ELEMENT — the probe's
 * answer, cached per element key — and it outlives the config that asked for it, so a
 * layer that reads it alone keeps rendering tiles after the user turns tiling off (and
 * two layers on one element cannot disagree). The config is the per-layer half.
 */
function usesTiledPath(
  engine: PointsDataEngine,
  elementKey: string,
  config: PointsLayerConfig | undefined
): boolean {
  return pointsTilingEnabled(config?.pointsTiling) && engine.isTiled(elementKey);
}

export function useLayerData(
  layers: Record<string, LayerConfig>,
  layerOrder: string[],
  availableElements: ElementsByType,
  coordinateSystem: string | null,
  spatialData?: SpatialData,
  vivPassthrough?: VivImagePassthroughOptions,
  featureColorResolver?: FeatureColorResolver
): UseLayerDataResult {
  const { getOmeZarrMultiscalesData } = useVivLoaderRegistry();

  // Collapses a host's per-render wrapper churn onto the buffer identity, so a
  // resolver that reuses its bytes never costs a re-upload. See its doc comment.
  const stabilizeFeatureColors = useMemo(() => createFeatureColorStabilizer(), []);

  // Cache for loaded data
  const loadedDataRef = useRef<LoadedData>({
    worldBounds: new Map(),
  });
  // The shapes and labels Renderer Adapters (ADR 0004 §4): the `project()` half, in
  // `@spatialdata/layers` where the deck dependency already is. Everything the
  // render path needs that is neither resolved data nor a raw config prop — merged
  // geometry, prebuilt feature arrays, fill-colour maps, the feature-state runtime,
  // the per-label LUT — is held there, keyed and identity-stable.
  //
  // Hook lifetime, not `spatialData` lifetime: the caches these replaced lived in
  // `loadedDataRef`, which a dataset swap does not rebuild. Keeping that is safe
  // because every memo inside keys on its source object's identity, so a swap
  // (which replaces those sources) cannot serve a stale value — see the adapters'
  // own notes. Points is the exception only in where its adapter hangs:
  // `PointsDataEngine` owns one privately.
  const shapesAdapter = useMemo(() => new ShapesRendererAdapter(), []);
  const labelsAdapter = useMemo(() => new LabelsRendererAdapter(), []);
  useEffect(
    () => () => {
      shapesAdapter.dispose();
      labelsAdapter.dispose();
    },
    [shapesAdapter, labelsAdapter]
  );
  const stableSelectionArraysRef = useRef<
    Map<string, { signature: string; value: RasterSelection[] }>
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

  // Recomputed every render, NOT memoised on `layers`: a caller that patches its
  // configs in place changes nothing this hook could memoise on. It is a handful of
  // scalars per visible layer — see `describeResolveInputs` for what may live in it.
  const resolveInputsKey = describeResolveInputs(layers, layerOrder);

  const [layerLoadStates, setLayerLoadStates] = useState<Record<string, LayerLoadState>>({});
  // Bumped on every resolver settle. The reconcile effect depends on it so that an
  // async settle (e.g. the preload landing, which flips `supportsFeatureScan`) re-runs
  // planning — this is what lets the row-codes and feature-index scan be planned from
  // the commit phase (Track A) instead of kicked imperatively during render.
  const [loadedDataRevision, setLoadedDataRevision] = useState(0);

  const notifyLoadedDataChanged = useCallback(() => {
    setLoadedDataRevision((revision) => revision + 1);
  }, []);

  // Hover highlight for labels (runtime render state, never config — it changes on
  // every pointer move and must not reach a saved Render Stack).
  //
  // ONE entry, not a per-layer map: only one thing is under the cursor at a time, so
  // a single slot makes "moved to a different layer" and "moved off" the same
  // transition instead of two bookkeeping cases that can disagree.
  //
  // A ref plus a version counter rather than plain state: deck fires hover on every
  // pointer move, but the highlight only changes when the pointer crosses INTO A
  // DIFFERENT LABEL, so the re-render is gated on that transition rather than on
  // pointer motion. `getLayers` reads the ref during render.
  const hoveredLabelRef = useRef<{ layerId: string; labelId: number } | null>(null);
  const [, setHoveredLabelRevision] = useState(0);

  const setHoveredLabel = useCallback((next: { layerId: string; labelId: number } | null) => {
    const prev = hoveredLabelRef.current;
    if (prev?.layerId === next?.layerId && prev?.labelId === next?.labelId) {
      return;
    }
    hoveredLabelRef.current = next;
    setHoveredLabelRevision((revision) => revision + 1);
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

  // Per-layer tile-status stores for the Morton path (D5). One per points layer,
  // created on first render of a tiled layer and kept for its lifetime — the store is
  // a `PointsLayer` prop, so a fresh one per render would churn the debug overlay.
  // Its `update` no-ops when the state signature is unchanged, so the notify below
  // fires on real tile transitions only, not on every deck frame.
  const tileDebugStoresRef = useRef(new Map<string, TileDebugStore>());
  const getTileDebugStore = useCallback(
    (layerId: string): TileDebugStore => {
      const stores = tileDebugStoresRef.current;
      let store = stores.get(layerId);
      if (!store) {
        store = createTileDebugStore(notifyLoadedDataChanged);
        stores.set(layerId, store);
      }
      return store;
    },
    [notifyLoadedDataChanged]
  );

  // Forget a layer's tile-status store once its tiles stop being real.
  //
  // The store map only grows on its own: deck's `Tileset2D.finalize()` clears its cache
  // WITHOUT firing the `onTileUnload` that prunes a store, so a removed or de-tiled layer
  // leaves its last state behind — counted in the global tile progress, and handed
  // straight back if the layer is ever toggled on again, painting a previous session's
  // tiles over ground nothing has fetched.
  const forgetTileDebugStore = useCallback((layerId: string) => {
    tileDebugStoresRef.current.delete(layerId);
  }, []);

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
  // The cleanup below is why the store's resolver bridge is tied to having listeners
  // rather than to construction. An effect cleanup is not "the end": StrictMode's
  // dev double-mount runs it and then re-runs the effect against the SAME memoised
  // store, so `dispose()` here has to be recoverable — `subscribe` re-attaches. It
  // also means a store the `useMemo` above builds and discards never subscribed to
  // anything, so it holds nothing to leak. See `SpatialEntryStore.attachResolvers`.
  useEffect(() => {
    const unsubscribe = store.subscribe(notifyLoadedDataChanged);
    return () => {
      unsubscribe();
      store.dispose();
    };
  }, [store, notifyLoadedDataChanged]);

  // Prune tile-status stores for layers that no longer draw tiles — see
  // `forgetTileDebugStore`. Commit phase, because it mutates the map; the render-phase
  // aggregate filters independently, so a store surviving one extra commit is invisible.
  useEffect(() => {
    // Bare reference: the probe settling is what turns `usesTiledPath` false for an
    // element that stopped being tileable, and it changes nothing else this body reads.
    void loadedDataRevision;
    for (const layerId of [...tileDebugStoresRef.current.keys()]) {
      const config = layers[layerId];
      const elem = config ? resolveLayerElement(layerId, config, elementMapValue) : undefined;
      const stillTiled =
        config?.type === 'points' && elem ? usesTiledPath(pointsEngine, elem.key, config) : false;
      if (!stillTiled) forgetTileDebugStore(layerId);
    }
  }, [layers, elementMapValue, pointsEngine, loadedDataRevision, forgetTileDebugStore]);

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
  //
  // And on `resolveInputsKey`, which is what makes the effect fire for a caller that
  // edits its configs IN PLACE (MDV's render-stack adapter does, deliberately). For
  // such a caller neither `layers` nor the config objects inside it ever change
  // identity, so identity deps alone leave a switched fill-colour column or tooltip
  // field never requested at all. See `describeResolveInputs`.
  useEffect(() => {
    // Bare reference: `loadedDataRevision` is a re-trigger, not a value we read. A
    // resolver settle (the preload landing flips `supportsFeatureScan`) must replan so
    // the scan/row-codes tasks get emitted; touching it here declares that dependency
    // honestly to exhaustive-deps. The plan/load dedup makes the extra runs convergent.
    void loadedDataRevision;
    // Bare reference, same reason: the contexts below are read from `layers`, so the
    // key is never a value this body uses — it is the only thing that CHANGES when a
    // caller mutates those configs in place. Declaring it here is what makes it a
    // legitimate dependency rather than an "unnecessary" one.
    void resolveInputsKey;
    const contexts: AnyResolveContext[] = [];
    for (const layerId of layerOrder) {
      const config = layers[layerId];
      if (!config?.visible) continue;
      const elem = resolveLayerElement(layerId, config, elementMapValue);
      const ctx = elem ? buildResolveContext(layerId, config, elem, pointsEngine) : undefined;
      if (ctx) contexts.push(ctx);
    }
    void store.reconcile(contexts);
    // `pointsEngine` is the stable useState value, so this adds no churn; it is in
    // the list because the name→code resolution above reads its catalog. The catalog
    // ARRIVING is covered by `loadedDataRevision` (bumped on every resolver settle),
    // which is what re-resolves a name selection that could not be resolved yet.
  }, [
    layers,
    layerOrder,
    resolveInputsKey,
    store,
    elementMapValue,
    loadedDataRevision,
    pointsEngine,
  ]);

  // --- Renderer Adapter bindings ------------------------------------------------
  //
  // Thin pass-throughs: each resolves the resources its adapter needs out of the
  // resolver and hands them over. The caches, signatures and identity rules all
  // live in the adapter (`@spatialdata/layers`).

  // Coupling #1: the resolver keeps geometry and tooltip metadata independent, so
  // the render/pick sites need geometry with `rowIndexByFeatureIndex` patched by the
  // tooltip's `tooltipRowIndices`. The adapter memoises the join.
  const getMergedShapeRenderData = useCallback(
    (key: string): ShapesRenderData | undefined => {
      const raw = shapesResolver.getRenderData(key);
      if (!raw) return undefined;
      return shapesAdapter.getRenderData(
        key,
        raw,
        shapesResolver.getTooltipMetadata(key)?.tooltipRowIndices
      );
    },
    [shapesResolver, shapesAdapter]
  );

  const getShapePrebuilt = useCallback(
    (layerId: string, renderData: ShapesRenderData, hiddenIds: string[] | undefined) =>
      shapesAdapter.getPrebuilt(layerId, renderData, hiddenIds),
    [shapesAdapter]
  );

  const reloadElement = useCallback(
    (type: string, key: string) => {
      const loaded = loadedDataRef.current;
      if (type === 'shapes') {
        shapesResolver.evict(key);
        shapesAdapter.evictElement(key);
        loaded.worldBounds.delete(`shapes:${key}`);
        // Clear per-layer projections for every layer that maps to this key.
        for (const [layerId, config] of Object.entries(layersRef.current)) {
          if (config.type === 'shapes' && config.elementKey === key) {
            shapesAdapter.evictLayer(layerId);
          }
        }
      } else if (type === 'points') {
        pointsEngine.evict(key);
        loaded.worldBounds.delete(`points:${key}`);
        // `evict` resets the tiling slot, so every tile the overlay is holding for this
        // element describes a loader that no longer exists.
        for (const [layerId, config] of Object.entries(layersRef.current)) {
          if (config.type === 'points' && config.elementKey === key) {
            forgetTileDebugStore(layerId);
          }
        }
      } else if (type === 'image') {
        imagesResolver.evict(key);
        loaded.worldBounds.delete(`image:${key}`);
      } else if (type === 'labels') {
        labelsResolver.evict(key);
        loaded.worldBounds.delete(`labels:${key}`);
        for (const [layerId, config] of Object.entries(layersRef.current)) {
          if (config.type === 'labels' && config.elementKey === key) {
            labelsAdapter.evictLayer(layerId);
          }
        }
      }
      // The resolver/engine effects will pick up the missing data and reload
    },
    [
      pointsEngine,
      shapesResolver,
      imagesResolver,
      labelsResolver,
      shapesAdapter,
      labelsAdapter,
      forgetTileDebugStore,
    ]
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
        // A tiled element is renderable with no resident batch at all: its extent is
        // known from the artifact and its geometry arrives per viewport tile. Reading
        // only `hasData` would report "nothing to draw" forever and leave the
        // blocking overlay up over a layer that is drawing fine.
        const pointsConfig = layersRef.current[layerId];
        return (
          pointsEngine.hasData(elem.key) ||
          usesTiledPath(
            pointsEngine,
            elem.key,
            pointsConfig?.type === 'points' ? pointsConfig : undefined
          )
        );
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
          // A tiled element is framed from the artifact's own extent — there is no
          // resident geometry to measure, and waiting for one would mean never
          // auto-fitting. Cached against the metadata's identity, like the preloaded
          // path is against its batch.
          const tilingMetadata =
            config.type === 'points' && usesTiledPath(pointsEngine, elem.key, config)
              ? pointsEngine.getTilingMetadata(elem.key)
              : undefined;
          if (tilingMetadata?.bounds) {
            const elementBounds = tilingMetadata.bounds;
            return getCachedWorldBounds(
              loaded.worldBounds,
              getWorldBoundsCacheKey(elem),
              tilingMetadata,
              elem.transform,
              () => transformAxisAlignedBounds(elementBounds, elem.transform)
            );
          }
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
            // Host-computed colours, indexed by feature index. The resolver is given
            // the ordering it must build against — a shape's index belongs to the
            // loaded geometry, not to the data.
            const hostFeatureColors = stabilizeFeatureColors(
              layerId,
              featureColorResolver?.({
                layerId,
                elementKey: elem.key,
                kind: 'shapes',
                featureIds: renderData.featureIds,
              })
            );
            const layer = shapesAdapter.render({
              layerId,
              elementKey: elem.key,
              props: config,
              renderData,
              fillColorRows: shapesResolver.getFillColorRows(elem.key),
              modelMatrix: elem.transform,
              ...(hostFeatureColors ? { featureColors: hostFeatureColors } : {}),
              pickingEnabled,
            });
            // The binary polygon path returns [fill, outline]; flatten so both
            // reach deck as siblings (the outline draws over the fill).
            if (Array.isArray(layer)) deckLayers.push(...layer);
            else if (layer) deckLayers.push(layer);
          }
        } else if (config.type === 'points' && usesTiledPath(pointsEngine, elem.key, config)) {
          // --- Morton viewport tiles ---------------------------------------------
          //
          // A separate branch, not a variation of the preloaded one below: the tiled path
          // has no resident batch, so none of the resident/matched/partial machinery
          // applies. Geometry and per-point feature codes both come from `loadInBounds`,
          // per viewport tile, inside deck's `TileLayer` lifecycle.
          //
          // The filter is pushed down into the row-group scan, so a tile arrives holding
          // only the selected features. That cuts what is uploaded and drawn, NOT what is
          // read: row groups are chosen spatially and a gene's points are spread across
          // all of them (ADR 0002/0003).
          const element = elem.element as PointsElement;
          // `undefined` means "no filter"; an empty array means "filter to nothing".
          // Both reach `loadInBounds` unchanged and the scan honours the distinction.
          const tiledFeatureCodes = resolveFeatureSelectionCodes(
            config,
            pointsEngine.getFeatureCatalog(elem.key)
          );
          const tiledResource = pointsEngine.getTiledResource(element, elem.key);
          if (tiledResource) {
            const showTileDebugOverlay = config.showTileDebugOverlay === true;
            const tileDebugStore = getTileDebugStore(layerId);
            // The same element-scoped colour inputs the preloaded branch builds; only
            // the per-point codes arrive by a different route.
            const featureCodeSpaceSize = pointsEngine.getFeatureCodeSpaceSize(elem.key);
            const featureColorOverrides = pointsEngine.getFeatureColorOverrideMap(
              elem.key,
              config.featureColorOverrides
            );
            const highlightFeatureCode = pointsEngine.getHighlightedFeature(elem.key);
            deckLayers.push(
              new PointsLayer({
                id: layerId,
                resource: tiledResource,
                modelMatrix: elem.transform,
                opacity: config.opacity,
                visible: config.visible,
                pointSize: config.pointSize ?? 1,
                ...(config.color ? { color: config.color } : {}),
                // Always passed: the footer's tile progress reads it whether or not the
                // overlay is drawn.
                tileDebugStore,
                showTileDebugOverlay,
                ...(showTileDebugOverlay
                  ? { tileDebugSignature: tileDebugSignature(tileDebugStore) }
                  : {}),
                ...(tiledFeatureCodes ? { featureCodes: tiledFeatureCodes } : {}),
                colorByFeature: config.colorByFeature !== false,
                featureCodeSpaceSize,
                ...(featureColorOverrides ? { featureColorOverrides } : {}),
                highlightFeatureCode,
              })
            );
          }
        } else if (config.type === 'points') {
          const element = elem.element as PointsElement;
          const featureCodes = resolveFeatureSelectionCodes(
            config,
            pointsEngine.getFeatureCatalog(elem.key)
          );
          const selectionActive = featureCodes !== undefined && featureCodes.length > 0;
          // Sizes the colour LUT so every point's feature code indexes a real texel.
          const featureCodeSpaceSize = pointsEngine.getFeatureCodeSpaceSize(elem.key);
          // Resolve config's by-name colour overrides to a stable code→rgb map for the
          // LUT (identity-stable so the palette texture is not rebuilt every frame).
          const featureColorOverrides = pointsEngine.getFeatureColorOverrideMap(
            elem.key,
            config.featureColorOverrides
          );
          // Hover highlight (runtime): emphasise the hovered feature's points, -1 (no
          // highlight) otherwise. Held on the engine — the shared external store the
          // feature panel writes to and this render path reads — so it needs no store /
          // renderStack plumbing. A uniform, so it costs nothing per frame.
          const highlightFeatureCode = pointsEngine.getHighlightedFeature(elem.key);

          // Feature-index render scan: when a selection is active, the WHOLE
          // dataset's matching points are loaded (footer stats skip the row groups a
          // selected feature can't live in), so features outside the resident preload
          // window still render. The scan is PLANNED from the reconcile effect (Track
          // A) — `getLayers` only READS its result here. `getMatchingResource`
          // returns the LAST completed matched batch, so a selection change keeps
          // showing the prior selection's points until the new scan settles (no blank
          // mid-scan).
          //
          // Gated on scan capability: an authoritative code column (footer stats
          // skip row groups) OR a dictionary-only element with a catalog loaded —
          // there the scan reads the whole file and matches each row's feature_name
          // against the catalog's code space, so a selected gene's points render
          // even when they fall outside the resident preload window. Before any
          // catalog loads (no shared code space) there is nothing to match names
          // against, so it falls through to resident in-memory filtering.
          const canFeatureScan = pointsEngine.supportsFeatureScan(elem.key);
          let partialResource: PointsRenderResource | null = null;
          // The selected genes the LAST-GOOD scan already covers. This is the pivot of
          // the show/hide policy: the whole-dataset matched batch survives a selection
          // change as `stale`, so `covered` is the previous scan's genes. Intersecting
          // it with the CURRENT selection gives exactly the genes we may safely draw
          // from that batch — never a deselected gene (that would be bug B: a gene shown
          // when it shouldn't be), and never dropping a still-wanted gene the scan
          // already has (bug A: a wanted gene vanishing when the selection grows).
          let coveredSelection: readonly number[] | undefined;
          if (selectionActive && canFeatureScan && featureCodes !== undefined) {
            const covered = pointsEngine.getLoadedMatchingFeatureCodes(elem.key);
            coveredSelection =
              covered !== undefined ? featureCodes.filter((code) => covered.has(code)) : [];
            partialResource = pointsEngine.getMatchingPartialResource(element, elem.key);
          }

          // Choose the base batch: the whole-dataset matched batch whenever it covers
          // ANY still-wanted gene (drawn filtered to that covered subset), else the
          // resident preload. Growing [A]→[A,B] keeps A on screen from the matched batch
          // while B's scan streams in via the overlay, instead of blinking A out to the
          // resident window. Both flow through ONE stable base resource
          // (`getBaseResource`) whose backing batch swaps under it — so the base never
          // tears down as the view evolves resident↔matched (the base flicker). An empty
          // matched batch (a scan that matched nothing) falls back to resident.
          const matchedCandidate =
            coveredSelection && coveredSelection.length > 0
              ? pointsEngine.getMatchedBatch(elem.key)
              : undefined;
          // The filter that would have to be applied to draw the matched batch: a
          // strict subset of what the scan covers means genes in the batch must be
          // held back.
          const matchedRowCodes = matchedCandidate
            ? pointsEngine.getMatchingRowFeatureCodes(elem.key)
            : undefined;
          const matchedCoveredSize =
            pointsEngine.getLoadedMatchingFeatureCodes(elem.key)?.size ?? 0;
          const matchedFilter =
            coveredSelection !== undefined && coveredSelection.length < matchedCoveredSize
              ? coveredSelection
              : undefined;
          // ...but `PointsLayer` cannot apply a feature filter without row-aligned
          // codes, and its strategy resolves that case by drawing the batch WHOLE.
          // Handing it a filter it will decline is therefore not a no-op — it
          // surfaces every gene the scan covered, including the one just deselected.
          // Gate on the layer's OWN predicate (imported, not re-derived, so the two
          // cannot drift) and fall back to the resident base, which filters in memory.
          const matchedBatch = featureFilterAwaitingRowCodes(matchedFilter, matchedRowCodes)
            ? undefined
            : matchedCandidate;
          const useMatched = matchedBatch !== undefined && (matchedBatch.shape[1] ?? 0) > 0;
          // Falling back to the in-flight preload's growing buffer (D3) is what makes a
          // COLD load paint progressively: until the first full window settles there is
          // no resident batch, and the base would otherwise draw nothing. It flows
          // through the same stable base resource, so the growth is a revision bump —
          // no teardown, no flicker.
          const baseBatch = useMatched
            ? matchedBatch
            : (pointsEngine.getData(elem.key) ?? pointsEngine.getPreloadPartialBatch(elem.key));

          // Per-row codes say WHICH feature each point is, so they are not colour's
          // input alone: the filter masks with them and the hover tooltip names the
          // feature from them. Gating them on `colorByFeature` left a layer with
          // colour turned off unable to say what the point under the cursor was.
          // Colour is now switched by the layer prop below, not by withholding the
          // codes, so threading them always does not turn colour back on.
          let basePreloadedCodes: ArrayLike<number> | undefined;
          let baseFilter: readonly number[] | undefined;
          if (useMatched) {
            basePreloadedCodes = matchedRowCodes;
            // Filter the whole-dataset batch to the still-wanted covered subset unless
            // the selection is exactly the scanned set (then render it whole). The batch
            // only holds covered genes, so this can only ever DROP a deselected gene —
            // never surface an unselected one. That holds because the gate above
            // guarantees the filter is applicable; without it the drop silently
            // becomes a no-op and the deselected gene stays on screen.
            baseFilter = matchedFilter;
          } else {
            // Row codes drive both the in-memory filter (resident → selection) and
            // colour-by-feature. The row-codes LOAD is planned from the reconcile
            // effect (Track A), not kicked here.
            basePreloadedCodes = pointsEngine.getRowFeatureCodes(elem.key);
            baseFilter = featureCodes;
          }

          const baseResource = pointsEngine.getBaseResource(element, elem.key, baseBatch);
          if (baseResource) {
            deckLayers.push(
              new PointsLayer({
                id: layerId,
                resource: baseResource,
                // Stable resource; the revision bumps when the base batch is swapped
                // (resident↔matched↔streaming) so the composite re-reads without a
                // teardown — no base flicker on selection change or scan settle.
                resourceRevision: pointsEngine.getBaseRevision(elem.key),
                modelMatrix: elem.transform,
                opacity: config.opacity,
                visible: config.visible,
                // Legacy renderPointsLayer defaulted radius to 1px; preserve that for
                // parity (the composite's own default is smaller).
                pointSize: config.pointSize ?? 1,
                ...(baseFilter ? { featureCodes: baseFilter } : {}),
                ...(basePreloadedCodes ? { preloadedFeatureCodes: basePreloadedCodes } : {}),
                ...(config.color ? { color: config.color } : {}),
                colorByFeature: config.colorByFeature !== false,
                featureCodeSpaceSize,
                ...(featureColorOverrides ? { featureColorOverrides } : {}),
                highlightFeatureCode,
              })
            );
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
                id: partialLayerId(layerId),
                resource: partialResource,
                // Stable resource across chunks; the revision bumps as the buffer
                // grows so the overlay re-reads without a per-chunk teardown (D10).
                resourceRevision: pointsEngine.getMatchingPartialRevision(elem.key),
                modelMatrix: elem.transform,
                opacity: config.opacity,
                visible: config.visible,
                pointSize: config.pointSize ?? 1,
                ...(featureCodes ? { featureCodes } : {}),
                ...(partialRowCodes ? { preloadedFeatureCodes: partialRowCodes } : {}),
                ...(config.color ? { color: config.color } : {}),
                colorByFeature: config.colorByFeature !== false,
                featureCodeSpaceSize,
                ...(featureColorOverrides ? { featureColorOverrides } : {}),
                highlightFeatureCode,
              })
            );
          }
        } else if (config.type === 'labels') {
          const labelsData = labelsResolver.getLoadedData(elem.key);
          if (labelsData) {
            // Selections are resolved here, not in the adapter: the clamp lives in
            // `@spatialdata/avivatorish`, which `layers` does not depend on.
            const ch = config.channels;
            const rawSelections =
              ch?.selections && ch.selections.length > 0
                ? ch.selections
                : (labelsData.selections ?? [{}]);
            const selections =
              labelsData.selectionAxisSizes !== undefined
                ? clampVivSelectionsToAxes(rawSelections, labelsData.selectionAxisSizes)
                : rawSelections;

            const hostFeatureColors = stabilizeFeatureColors(
              layerId,
              featureColorResolver?.({ layerId, elementKey: elem.key, kind: 'labels' })
            );
            // Only the layer actually under the cursor highlights; a stale id from a
            // layer that is no longer hovered must not tint a second element.
            const hoveredLabel = hoveredLabelRef.current;
            const highlightedLabelId =
              hoveredLabel?.layerId === layerId ? hoveredLabel.labelId : undefined;

            const layer = labelsAdapter.render({
              layerId,
              elementKey: elem.key,
              props: config,
              loader: labelsData.loader,
              channelDefaults: labelsData,
              selections: getStableSelections(`labels:${layerId}`, selections),
              fillColorRows: config.fillColorByColumn?.columnName
                ? labelsResolver.getFillColorRows(elem.key, config.fillColorByColumn.columnName)
                : undefined,
              modelMatrix: elem.transform,
              ...(hostFeatureColors ? { featureColors: hostFeatureColors } : {}),
              ...(highlightedLabelId !== undefined ? { highlightedLabelId } : {}),
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
      getTileDebugStore,
      getMergedShapeRenderData,
      shapesAdapter,
      labelsAdapter,
      shapesResolver,
      labelsResolver,
      featureColorResolver,
      stabilizeFeatureColors,
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

  const [entryStatusCache] = useState(() => new EntryStatusCache());

  // The same context the reconcile effect builds, so a status read or a retry
  // addresses the entry that was planned. Hidden layers resolve too: a host marking
  // failed layers in a layer list wants the ones switched off as well.
  const resolveEntryContext = useCallback(
    (layerId: string): AnyResolveContext | undefined => {
      const config = layersRef.current[layerId];
      const elem = resolveLayerElement(layerId, config, elementMap.current);
      return config && elem ? buildResolveContext(layerId, config, elem, pointsEngine) : undefined;
    },
    [pointsEngine]
  );

  const getEntryStatus = useCallback(
    (layerId: string): EntryStatus | undefined => {
      const config = layersRef.current[layerId];
      if (!config) return undefined;
      if (resolveLayerElement(layerId, config, elementMap.current)) {
        const ctx = resolveEntryContext(layerId);
        const snapshot = ctx ? store.snapshot(ctx) : undefined;
        return snapshot ? entryStatusCache.fromSnapshot(snapshot) : undefined;
      }
      // The reconcile effect skips an entry it cannot resolve; say why instead.
      if (!spatialData || !coordinateSystem) return undefined;
      return entryStatusCache.fromUnresolved(
        layerId,
        spatialData,
        coordinateSystem,
        config.type,
        config.elementKey
      );
    },
    [resolveEntryContext, store, entryStatusCache, spatialData, coordinateSystem]
  );

  const retryEntry = useCallback(
    async (layerId: string): Promise<void> => {
      const ctx = resolveEntryContext(layerId);
      if (ctx) await store.retry(ctx);
    },
    [resolveEntryContext, store]
  );

  const getFeatureTooltip = useCallback(
    (
      pickedLayerId: string,
      pickInfo: Pick<{ index?: number; object?: unknown }, 'index' | 'object'>
    ): SpatialFeatureTooltipData | undefined => {
      const layerId = layerIdForPick(pickedLayerId);
      const elem = resolveLayerElement(layerId, layersRef.current[layerId], elementMap.current);

      // The tile-status overlay, before the element guards below: it is a debug view of
      // the LOADER, not of a feature, so it needs the pick object and the layer's tile
      // store and nothing else. It is also the only place a tile's error message is
      // legible — the overlay can only paint a rectangle red, and "which tile, and why"
      // is exactly what you want when one goes red.
      if (isPointsTileDebugPickObject(pickInfo.object)) {
        const tooltip = formatPointsTileDebugTooltip(
          pickInfo.object.entry,
          pointsTileLoadProgressFromStore(tileDebugStoresRef.current.get(layerId))
        );
        return elem
          ? attachTooltipElementContext(tooltip, {
              elementKey: elem.key,
              elementType: elem.type,
              layerId,
            })
          : tooltip;
      }

      if (!elem) {
        return undefined;
      }

      const elementContext = {
        elementKey: elem.key,
        elementType: elem.type,
        layerId,
      };

      // Points carry no table association, so there is nothing to join and nothing
      // to configure: the pick object itself holds everything the tooltip shows.
      // The feature NAME is the one part that needs resolving — the point carries a
      // code, and the catalog that maps it is per element and arrives when it arrives.
      if (isPointsAvailableElement(elem)) {
        if (!isPointsPickObject(pickInfo.object)) {
          return undefined;
        }
        const pick = pickInfo.object;
        const catalog = pointsEngine.getFeatureCatalog(elem.key);
        const entry =
          pick.featureCode === undefined
            ? undefined
            : pointsEngine.getFeatureEntry(elem.key, pick.featureCode);
        return attachTooltipElementContext(
          formatPointsTooltip(pick, {
            ...(catalog?.featureKey ? { featureKey: catalog.featureKey } : {}),
            ...(entry ? { entry } : {}),
          }),
          elementContext
        );
      }

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
    [shapesResolver, labelsResolver, pointsEngine, getMergedShapeRenderData, getShapePrebuilt]
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
      pickedLayerId: string,
      pickInfo: Pick<{ index?: number; object?: unknown }, 'index' | 'object'>
    ): SpatialFeaturePickEventData | undefined => {
      const layerId = layerIdForPick(pickedLayerId);
      const elem = resolveLayerElement(layerId, layersRef.current[layerId], elementMap.current);
      if (!elem) {
        return undefined;
      }

      if (isPointsAvailableElement(elem)) {
        if (!isPointsPickObject(pickInfo.object)) {
          return undefined;
        }
        const pick = pickInfo.object;
        const featureName =
          pick.featureCode === undefined
            ? undefined
            : pointsEngine.getFeatureEntry(elem.key, pick.featureCode)?.name;
        return {
          elementKind: 'points',
          layerId,
          spatialElement: elem.element,
          ...(featureName !== undefined ? { featureId: featureName } : {}),
          ...(pick.featureCode !== undefined ? { featureCode: pick.featureCode } : {}),
          pointIndex: pick.pointIndex,
          position: pick.position,
          object: pick,
          tooltip: getFeatureTooltip(layerId, pickInfo),
        };
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
    [getFeatureTooltip, getShapePickEvent, labelsResolver, pointsEngine]
  );

  // Read during render, like the other resolver getters: every resolver settle
  // re-renders this hook via `loadedDataRevision`, so this is current. It is what
  // gives `getVivLayerProps` a new identity when an image loader lands — callers
  // memoise on that identity, and the load-status flags are not a substitute: a
  // load disposed mid-flight (StrictMode's dev double-mount) can flip them before
  // the live loader exists, leaving nothing to change when it does.
  const imageDataVersion = imagesResolver.getVersion();

  const getVivLayerProps = useCallback((): ImageLayerConfig[] => {
    // Bare reference: a re-trigger for the image data read below, not a value used.
    void imageDataVersion;
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
  }, [layers, layerOrder, getStableSelections, vivPassthrough, imagesResolver, imageDataVersion]);

  /**
   * Viewport-tile progress across every tiled points layer (D5).
   *
   * Tiles load inside deck's `TileLayer`, not through a resolver, so they never touch
   * `layerLoadStates` — without this a tiled layer reports "nothing loading" while it
   * is fetching row groups. Recomputed on `loadedDataRevision`, which the tile debug
   * stores bump when a tile actually starts or finishes.
   */
  const pointsTileProgress = useMemo((): PointsTileLoadProgress => {
    // Bare reference: the stores are read through a ref (they must not re-create per
    // render), so the revision is the only thing that CHANGES when a tile transitions.
    void loadedDataRevision;
    const byLayer = new Map<string, PointsTileLoadProgress>();
    // Driven by the CURRENT layers, not by the store map. The map only grows — deck's
    // `Tileset2D.finalize()` clears its cache without firing the `onTileUnload` that
    // prunes a store — so a layer that was hidden, removed, or switched to
    // `pointsTiling: 'off'` mid-request would otherwise keep contributing its last
    // `inFlight` count to the global spinner forever.
    for (const layerId of layerOrder) {
      const config = layers[layerId];
      if (!config?.visible || config.type !== 'points') continue;
      // eslint-disable-next-line react-hooks/refs -- intentional external-store read; see the isBlocking note below
      const elem = resolveLayerElement(layerId, config, elementMap.current);
      if (!elem || !usesTiledPath(pointsEngine, elem.key, config)) continue;
      // eslint-disable-next-line react-hooks/refs -- intentional external-store read; see the isBlocking note below
      const store = tileDebugStoresRef.current.get(layerId);
      if (store) byLayer.set(layerId, pointsTileLoadProgressFromStore(store));
    }
    return aggregatePointsTileLoadProgress(byLayer);
  }, [loadedDataRevision, layers, layerOrder, pointsEngine]);

  const isLoading = useMemo(
    () =>
      Object.values(layerLoadStates).some((state) =>
        Object.values(state).some((status) => status === 'loading')
      ) || isPointsTileLoading(pointsTileProgress),
    [layerLoadStates, pointsTileProgress]
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
    getEntryStatus,
    retryEntry,
    hasRenderableLayerData,
    pointsEngine,
    resolvePointsTarget,
    getFeatureTooltip,
    getFeaturePickEvent,
    getShapePickEvent,
    setHoveredLabel,
    isLoading,
    isBlocking,
    reloadElement,
    getWorldBoundsForLayer,
    getWorldBoundsForVisibleLayers,
  };
}
