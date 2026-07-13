import type { PointsElement } from './models/index.js';
import type { PointsLoadMode } from './types.js';
import type {
  PointsInBoundsResponse,
  PointsTilingMetadata,
  SpatialBounds,
} from './pointsTiling.js';

export type PointsEncodingKind =
  | 'preloaded-columnar'
  | 'morton-tiled'
  | 'geoarrow-binary'
  | 'geoarrow-tiled';

export type PointsBatchFormat = 'columnar-ndarray' | 'arrow-record-batch';

export interface PointsLoaderCapabilities {
  kind: PointsEncodingKind;
  batchFormat: PointsBatchFormat;
  bounds?: SpatialBounds;
  supportsViewportTiles: boolean;
  supportsFeatureCodes?: boolean;
}

export interface ColumnarNdarrayPointsBatch {
  format: 'columnar-ndarray';
  data: ArrayLike<number>[];
  shape: number[];
  bounds?: SpatialBounds;
  loadMode?: PointsLoadMode;
  pointCount?: number;
  /**
   * Per-point feature code, aligned row-for-row with the geometry columns in
   * {@link data}. Present when the source resolved a feature key; consumed by the
   * render path to build a GPU `featureCode` attribute (colour-by-feature and
   * per-code visibility). Any transform that reorders or truncates {@link data}
   * (feature filter, render cap) must permute this in lockstep.
   */
  featureCodes?: ArrayLike<number>;
}

export type PointsBatch = ColumnarNdarrayPointsBatch;

export interface PointsLoadInBoundsOptions {
  bounds: SpatialBounds;
  featureCodes?: readonly number[];
  signal?: AbortSignal;
}

export interface CorePointsLoader {
  readonly capabilities: PointsLoaderCapabilities;
  loadInBounds(options: PointsLoadInBoundsOptions): Promise<PointsBatch | null>;
  loadAll?(options?: { signal?: AbortSignal }): Promise<PointsBatch>;
}

export interface PreloadedColumnarInput {
  shape: number[];
  data: ArrayLike<number>[];
  /** Optional per-point feature codes, carried onto the batch for colouring. */
  featureCodes?: ArrayLike<number>;
}

export function resolvePointsEncoding(
  preloaded: PreloadedColumnarInput | null | undefined,
  metadata: PointsTilingMetadata | null | undefined,
  wantsOptimized: boolean
): PointsEncodingKind {
  if (preloaded) {
    return 'preloaded-columnar';
  }
  if (wantsOptimized && metadata?.supportsRowGroupRangeReads && metadata.bounds) {
    return 'morton-tiled';
  }
  return 'preloaded-columnar';
}

function columnarPointCount(shape: number[], data: ArrayLike<number>[]): number {
  if (shape.length >= 2 && Number.isFinite(shape[1])) {
    return shape[1];
  }
  const fromData = data[0]?.length;
  if (typeof fromData === 'number') {
    return fromData;
  }
  return shape[0] ?? 0;
}

function toColumnarBatch(
  result: PointsInBoundsResponse | PreloadedColumnarInput,
  overrides?: Partial<ColumnarNdarrayPointsBatch>
): ColumnarNdarrayPointsBatch {
  const shape = result.shape ?? [];
  const data = result.data;
  const pointCount = columnarPointCount(shape, data);
  const featureCodes = 'featureCodes' in result ? result.featureCodes : undefined;
  return {
    format: 'columnar-ndarray',
    data,
    shape,
    bounds: 'bounds' in result ? result.bounds : overrides?.bounds,
    loadMode: 'loadMode' in result ? result.loadMode : overrides?.loadMode,
    pointCount,
    ...(featureCodes ? { featureCodes } : {}),
    ...overrides,
  };
}

export function createMortonTiledPointsLoader(
  element: PointsElement,
  metadata: PointsTilingMetadata
): CorePointsLoader {
  const capabilities: PointsLoaderCapabilities = {
    kind: 'morton-tiled',
    batchFormat: 'columnar-ndarray',
    bounds: metadata.bounds,
    supportsViewportTiles: true,
    supportsFeatureCodes: Boolean(metadata.featureKey),
  };

  return {
    capabilities,
    async loadInBounds(options: PointsLoadInBoundsOptions): Promise<PointsBatch | null> {
      const result = await element.loadPointsInBounds(options);
      return toColumnarBatch(result);
    },
  };
}

export function createPreloadedColumnarPointsLoader(
  element: PointsElement,
  preloaded: PreloadedColumnarInput
): CorePointsLoader {
  const batch = toColumnarBatch(preloaded, { loadMode: 'full-filter' });
  const capabilities: PointsLoaderCapabilities = {
    kind: 'preloaded-columnar',
    batchFormat: 'columnar-ndarray',
    bounds: inferBoundsFromColumnar(preloaded),
    supportsViewportTiles: false,
    supportsFeatureCodes: true,
  };

  return {
    capabilities,
    async loadInBounds(options: PointsLoadInBoundsOptions): Promise<PointsBatch | null> {
      void element;
      void options;
      return batch;
    },
    async loadAll() {
      return batch;
    },
  };
}

function inferBoundsFromColumnar(preloaded: PreloadedColumnarInput) {
  const xs = preloaded.data[0];
  const ys = preloaded.data[1];
  if (!xs || !ys || preloaded.shape[0] === 0) {
    return undefined;
  }
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const count = preloaded.shape[0];
  for (let index = 0; index < count; index += 1) {
    const x = xs[index];
    const y = ys[index];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return undefined;
  }
  return { minX, minY, maxX, maxY };
}

export function createPointsLoaderForElement(
  element: PointsElement,
  options: {
    preloaded?: PreloadedColumnarInput | null;
    tilingMetadata?: PointsTilingMetadata | null;
    wantsOptimized: boolean;
  }
): CorePointsLoader | null {
  const encoding = resolvePointsEncoding(
    options.preloaded,
    options.tilingMetadata,
    options.wantsOptimized
  );

  if (encoding === 'morton-tiled' && options.tilingMetadata?.bounds) {
    return createMortonTiledPointsLoader(element, options.tilingMetadata);
  }

  if (options.preloaded) {
    return createPreloadedColumnarPointsLoader(element, options.preloaded);
  }

  return null;
}
