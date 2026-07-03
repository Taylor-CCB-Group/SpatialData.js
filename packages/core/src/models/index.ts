import * as ad from 'anndata.js';
import { createPrefixedStore } from 'zarrextra';
import type * as zarr from 'zarrita';
import {
  type CoordinateTransformation,
  type PointsAttrs,
  type RasterAttrs,
  type ShapesAttrs,
  type TableAttrs,
  pointsAttrsSchema,
  rasterAttrsSchema,
  shapesAttrsSchema,
  tableAttrsSchema,
} from '../schemas';
import type { PointsLoadOptions } from '../pointsLoadOptions.js';
import type { ShapesRenderData } from '../shapes';
import { isSpatialData, loadFeatureRowIndexByFeatureIndex } from '../tableAssociations';
import { type BaseTransformation, Identity, parseTransforms } from '../transformations';
import type {
  BadFileHandler,
  ElementName,
  LazyZarrArray,
  Result,
  SDataProps,
  TableColumnData,
  ZAttrsAny,
  ZarrTree,
} from '../types';
import { ATTRS_KEY } from '../types';
import { Err, Ok } from '../types';
import SpatialDataPointsSource from './VPointsSource';
import SpatialDataShapesSource from './VShapesSource';
import SpatialDataTableSource from './VTableSource';
import type { PointsFeatureCatalog } from '../pointsTiling.js';

/**
 * Parameters for creating element instances.
 * For internal use only and subject to change.
 */
export type ElementParams<T extends ElementName = ElementName> = {
  sdata: SDataProps;
  name: T;
  key: string;
  onBadFiles?: BadFileHandler;
};

// ============================================
// Abstract Base Classes
// ============================================

/**
 * Base class for all SpatialData elements.
 * Handles common functionality like URL construction and raw attrs access.
 */
abstract class AbstractElement<T extends ElementName> {
  readonly kind: T;
  readonly key: string;
  readonly path: string;
  readonly url?: string;
  protected readonly sdata: SDataProps;
  protected readonly rawAttrs: ZAttrsAny;
  protected readonly parsed: ZarrTree | LazyZarrArray<zarr.DataType>;

  constructor({ sdata, name, key }: ElementParams<T>) {
    this.sdata = sdata;
    this.kind = name;
    this.key = key;
    this.path = `${name}/${key}`;
    this.url = sdata.url ? `${sdata.url}/${this.path}` : undefined;

    const { tree } = sdata.rootStore;
    if (!tree) {
      throw new Error('Tree store contents not available');
    }
    if (!(name in tree)) {
      throw new Error(`Unknown element type: ${name}`);
    }
    const p1 = tree[name] as ZarrTree;
    if (!(key in p1)) {
      throw new Error(`Unknown element key: ${key}`);
    }
    this.parsed = p1[key];
    this.rawAttrs = ((p1[key] as ZarrTree)[ATTRS_KEY] as ZAttrsAny) ?? {};
  }
}

const DEFAULT_COORDINATE_SYSTEM = 'global';

/**
 * Error returned when a requested coordinate system is not available.
 */
export class CoordinateSystemNotFoundError extends Error {
  readonly coordinateSystem: string;
  readonly elementKey: string;
  readonly availableCoordinateSystems: string[];

  constructor(coordinateSystem: string, elementKey: string, available: string[]) {
    super(
      `No transformation to coordinate system '${coordinateSystem}' is available for element '${elementKey}'.\n` +
        `Available coordinate systems: [${available.join(', ')}]`
    );
    this.name = 'CoordinateSystemNotFoundError';
    this.coordinateSystem = coordinateSystem;
    this.elementKey = elementKey;
    this.availableCoordinateSystems = available;
  }
}

/**
 * Base class for spatial elements (everything except tables).
 * Spatial elements have coordinate transformations.
 */
abstract class AbstractSpatialElement<
  TKind extends Exclude<ElementName, 'tables'>,
  TAttrs,
> extends AbstractElement<TKind> {
  abstract readonly attrs: TAttrs;

  /**
   * Subclasses must implement this to provide access to their raw coordinate transformations.
   * Different element types store transforms in different locations.
   */
  protected abstract get rawCoordinateTransformations(): CoordinateTransformation | undefined;

  /**
   * Get the list of coordinate systems this element has transformations to.
   */
  get coordinateSystems(): string[] {
    const transforms = this.rawCoordinateTransformations;
    if (!transforms) return [];

    const systems = new Set<string>();
    for (const t of transforms) {
      const output = (t as { output?: { name?: string } }).output;
      systems.add(output?.name ?? DEFAULT_COORDINATE_SYSTEM);
    }
    return Array.from(systems);
  }

  /**
   * Get coordinate transformation for this element to a target coordinate system.
   * Returns a Result that the caller can unwrap or handle.
   *
   * @param toCoordinateSystem - Target coordinate system name. Defaults to 'global'.
   * @returns Result containing the transformation, or an error if not found
   *
   * @example
   * ```ts
   * const result = element.getTransformation('global');
   * if (result.ok) {
   *   const matrix = result.value.toMatrix();
   * } else {
   *   console.error(result.error.availableCoordinateSystems);
   * }
   *
   * // Or unwrap to throw on error:
   * const transform = unwrap(element.getTransformation('global'));
   * ```
   */
  getTransformation(
    toCoordinateSystem: string = DEFAULT_COORDINATE_SYSTEM
  ): Result<BaseTransformation, CoordinateSystemNotFoundError> {
    const allTransforms = this.getAllTransformations();

    const transform = allTransforms.get(toCoordinateSystem);
    if (!transform) {
      const available = Array.from(allTransforms.keys());
      return Err(new CoordinateSystemNotFoundError(toCoordinateSystem, this.key, available));
    }

    return Ok(transform);
  }

  /**
   * Get all coordinate system mappings for this element.
   * Groups transformations by their output coordinate system name.
   * @returns A Map from output coordinate system name to BaseTransformation
   */
  getAllTransformations(): Map<string, BaseTransformation> {
    const result = new Map<string, BaseTransformation>();
    const transforms = this.rawCoordinateTransformations;

    if (!transforms) return result;

    // Group raw transforms by output coordinate system
    const grouped = new Map<string, CoordinateTransformation>();
    for (const t of transforms) {
      const output = (t as { output?: { name?: string } }).output;
      const outputName = output?.name ?? DEFAULT_COORDINATE_SYSTEM;

      const existing = grouped.get(outputName);
      if (existing) {
        grouped.set(outputName, [...existing, t]);
      } else {
        grouped.set(outputName, [t]);
      }
    }

    // Parse each group into a BaseTransformation
    for (const [csName, coordTransforms] of grouped.entries()) {
      result.set(csName, parseTransforms(coordTransforms));
    }

    return result;
  }
}

export type TableKeys = {
  region: string[];
  regionKey: string;
  instanceKey: string;
};

// ============================================
// Table Element (non-spatial)
// ============================================

/**
 * Element representing an AnnData table.
 * Tables don't have spatial transformations.
 */
export class TableElement extends AbstractElement<'tables'> {
  readonly attrs: TableAttrs;
  private anndataPromise?: Promise<ad.AnnData<zarr.Readable, zarr.NumberDataType, zarr.Uint32>>;
  private readonly anndataStore: zarr.Readable;
  private readonly tableSource: SpatialDataTableSource;

  constructor(params: ElementParams<'tables'>) {
    super(params);
    // parse attrs through schema
    const result = tableAttrsSchema.safeParse(this.rawAttrs);
    if (!result.success) {
      throw result.error;
    }
    this.attrs = result.data;
    this.anndataStore = createPrefixedStore(params.sdata.rootStore.zarritaStore, this.path);
    this.tableSource = new SpatialDataTableSource({
      store: params.sdata.rootStore.zarritaStore,
      fileType: '.zarr',
    });
  }

  /**
   * Load the table as an AnnData.js object.
   */
  async getAnnDataJS(): Promise<ad.AnnData<zarr.Readable, zarr.NumberDataType, zarr.Uint32>> {
    if (!this.anndataPromise) {
      this.anndataPromise = ad.readZarr(this.anndataStore);
    }
    return await this.anndataPromise;
  }

  /**
   * Equivalent of SpatialData's Python-side `get_table_keys()`.
   * Returns normalized table association metadata, always exposing `region`
   * as an array for easier downstream matching.
   *
   * When the table has no region association metadata, `region` is an empty
   * array and `regionKey` / `instanceKey` are empty strings (subject to revision).
   */
  getTableKeys(): TableKeys {
    const { region, region_key, instance_key } = this.attrs;
    if (!region || !region_key || !instance_key) {
      return {
        region: [],
        regionKey: '',
        instanceKey: '',
      };
    }
    return {
      region: Array.isArray(region) ? region : [region],
      regionKey: region_key,
      instanceKey: instance_key,
    };
  }

  /**
   * Get available obs column names from the parsed tree.
   */
  getObsColumnNames(): string[] {
    const node = this.parsed as ZarrTree;
    const obsNode = node.obs as ZarrTree | undefined;
    if (!obsNode || typeof obsNode !== 'object') {
      return [];
    }
    return Object.keys(obsNode);
  }

  /**
   * Load the effective row ids for this table, respecting `instance_key`.
   *
   * This stays on our zarr-backed loader path rather than depending on
   * `anndata.js`, since tooltip/association reads should work even when the
   * AnnData wrapper lags behind newer string dtype support.
   */
  async loadObsIndex(): Promise<string[]> {
    return this.tableSource.loadObsIndex(`tables/${this.key}`);
  }

  /**
   * Load specific obs columns by column name.
   *
   * Column-level reads use the same direct zarr/parquet path as `loadObsIndex`
   * so feature-association helpers are not blocked on `anndata.js`.
   */
  async loadObsColumns(columnNames: string[]): Promise<Array<TableColumnData | undefined>> {
    return this.tableSource.loadObsColumns(
      columnNames.map((columnName) => `tables/${this.key}/obs/${columnName}`)
    ) as Promise<Array<TableColumnData | undefined>>;
  }
}

// ============================================
// Raster Elements (images & labels)
// ============================================

/**
 * Base class for raster elements (images and labels).
 * These share OME-NGFF multiscale structure and transformation logic.
 */
abstract class RasterElement<T extends 'images' | 'labels'> extends AbstractSpatialElement<
  T,
  RasterAttrs
> {
  readonly attrs: RasterAttrs;

  constructor(params: ElementParams<T>) {
    super(params);

    // Parse attrs through schema
    const result = rasterAttrsSchema.safeParse(this.rawAttrs);
    if (!result.success) {
      throw result.error;
    }
    this.attrs = result.data;
  }

  /**
   * Get the spatial axes from the first multiscale definition.
   */
  get spatialAxes() {
    return this.attrs.multiscales[0]?.axes.filter((a) => a.type === 'space') ?? [];
  }

  /**
   * Number of spatial dimensions (2 or 3).
   */
  get ndim(): 2 | 3 {
    return this.spatialAxes.length >= 3 ? 3 : 2;
  }

  /**
   * Whether this element has multiple resolution levels.
   */
  get isMultiscale(): boolean {
    return (this.attrs.multiscales[0]?.datasets.length ?? 0) > 1;
  }

  /**
   * Paths to all scale levels.
   */
  get scaleLevels(): string[] {
    return this.attrs.multiscales[0]?.datasets.map((d) => d.path) ?? [];
  }

  /**
   * Store view rooted at this raster element.
   *
   * Consumers that need codec-aware array loading should use this instead of
   * reconstructing a URL and letting downstream libraries create their own store.
   */
  getStore(): zarr.AsyncReadable {
    return createPrefixedStore(this.sdata.rootStore.zarritaStore, this.path);
  }

  /**
   * For raster elements, transformations are in multiscales[0].coordinateTransformations.
   */
  protected get rawCoordinateTransformations(): CoordinateTransformation | undefined {
    return this.attrs.multiscales[0]?.coordinateTransformations;
  }

  /**
   * Get transforms for a specific resolution level.
   * Returns both element-level and dataset-level transforms.
   */
  getTransformationForLevel(level: number | string, toCoordinateSystem?: string) {
    const datasets = this.attrs.multiscales[0]?.datasets ?? [];
    const dataset =
      typeof level === 'number' ? datasets[level] : datasets.find((d) => d.path === level);

    if (!dataset) return undefined;

    const datasetTransforms = dataset.coordinateTransformations;

    return {
      element: this.getTransformation(toCoordinateSystem),
      dataset: datasetTransforms ? parseTransforms(datasetTransforms) : new Identity(),
    };
  }
}

/**
 * Image element - raster data representing images.
 */
export class ImageElement extends RasterElement<'images'> {
  /**
   * Get channel metadata from omero attrs.
   */
  get channels() {
    return this.attrs.omero?.channels ?? [];
  }
}

/**
 * Labels element - raster data representing segmentation labels.
 *
 * Conceptually, labels and shapes both expose spatial "features" that can be
 * associated with table rows. For labels this will eventually come from picked
 * raster values (for example ObjectID-style segment ids), whereas shapes expose
 * feature identity via their row/index arrays.
 */
export class LabelsElement extends RasterElement<'labels'> {
  // Labels-specific methods can be added here
  // e.g., colormap, picked-feature identity / table association helpers, etc.
}

// ============================================
// Shapes Element
// ============================================

/**
 * Element representing geometric shapes (polygons, circles, etc.).
 */
export class ShapesElement extends AbstractSpatialElement<'shapes', ShapesAttrs> {
  readonly attrs: ShapesAttrs;
  private readonly vShapes: SpatialDataShapesSource;

  constructor(params: ElementParams<'shapes'>) {
    super(params);

    // Parse attrs through schema
    const result = shapesAttrsSchema.safeParse(this.rawAttrs);
    if (!result.success) {
      throw result.error;
    }
    this.attrs = result.data;

    // Initialize the Vitessce-derived shapes source for loading geometry
    this.vShapes = new SpatialDataShapesSource({
      store: params.sdata.rootStore.zarritaStore,
      fileType: '.zarr',
    });
  }

  /**
   * Transformations are at attrs.coordinateTransformations with input/output refs.
   */
  protected get rawCoordinateTransformations(): CoordinateTransformation | undefined {
    return this.attrs.coordinateTransformations;
  }

  /**
   * Load polygon geometry data.
   */
  async loadPolygonShapes() {
    return this.vShapes.loadPolygonShapes(`shapes/${this.key}/geometry`);
  }

  /**
   * Load circle/point geometry data.
   */
  async loadCircleShapes() {
    return this.vShapes.loadCircleShapes(`shapes/${this.key}/geometry`);
  }

  /**
   * Load stable feature ids for this shapes element.
   *
   * This is the preferred high-level API when the caller wants to associate a
   * picked shape with table rows. It corresponds to the same conceptual role
   * that picked label values will play for segmentation rasters.
   */
  async loadFeatureIds() {
    return this.vShapes.loadShapesIndex(`shapes/${this.key}`);
  }

  async loadRenderData(): Promise<ShapesRenderData> {
    const renderData = await this.vShapes.loadShapesRenderData(`shapes/${this.key}`);
    const spatialData = isSpatialData(this.sdata) ? this.sdata : undefined;
    renderData.rowIndexByFeatureIndex = await loadFeatureRowIndexByFeatureIndex({
      spatialData,
      kind: 'shapes',
      key: this.key,
      featureIds: renderData.featureIds,
    });
    return renderData;
  }

  async loadShapesInBounds(options: Parameters<SpatialDataShapesSource['loadShapesInBounds']>[1]) {
    return this.vShapes.loadShapesInBounds(`shapes/${this.key}`, options);
  }
}

// ============================================
// Points Element
// ============================================

/**
 * Element representing point cloud data.
 */
export class PointsElement extends AbstractSpatialElement<'points', PointsAttrs> {
  readonly attrs: PointsAttrs;
  private readonly vPoints: SpatialDataPointsSource;
  constructor(params: ElementParams<'points'>) {
    super(params);

    // Parse attrs through schema
    const result = pointsAttrsSchema.safeParse(this.rawAttrs);
    if (!result.success) {
      throw result.error;
    }
    this.attrs = result.data;
    this.vPoints = new SpatialDataPointsSource({
      store: params.sdata.rootStore.zarritaStore,
      fileType: '.zarr',
    });
  }

  /**
   * Transformations are at attrs.coordinateTransformations with input/output refs.
   */
  protected get rawCoordinateTransformations(): CoordinateTransformation | undefined {
    return this.attrs.coordinateTransformations;
  }

  async loadPoints(options?: PointsLoadOptions) {
    return this.vPoints.loadPoints(`points/${this.key}`, options);
  }

  async loadRowFeatureCodes(options?: {
    memoryCap?: number;
    featureCatalog?: PointsFeatureCatalog | null;
  }) {
    return this.vPoints.loadPointsRowFeatureCodes(`points/${this.key}`, options);
  }

  async loadFeatureCounts() {
    return this.vPoints.loadFeatureCounts(`points/${this.key}`);
  }

  async listFeaturesWithCounts() {
    return this.vPoints.listPointsFeaturesWithCounts(`points/${this.key}`);
  }

  async getPointsTilingMetadata() {
    return this.vPoints.getPointsTilingMetadata(`points/${this.key}`);
  }

  async loadPointsInBounds(options: Parameters<SpatialDataPointsSource['loadPointsInBounds']>[1]) {
    return this.vPoints.loadPointsInBounds(`points/${this.key}`, options);
  }

  async listFeatures() {
    return this.vPoints.listPointsFeatures(`points/${this.key}`);
  }

  async getParquetRowCount() {
    return this.vPoints.getPointsParquetRowCount(`points/${this.key}`);
  }
}

// ============================================
// Factory
// ============================================

/**
 * Factory functions for creating element instances.
 * Using functions instead of constructors directly allows proper type inference
 * when indexing into the map.
 */
const elementFactories = {
  tables: (p: ElementParams<'tables'>) => new TableElement(p),
  shapes: (p: ElementParams<'shapes'>) => new ShapesElement(p),
  images: (p: ElementParams<'images'>) => new ImageElement(p),
  labels: (p: ElementParams<'labels'>) => new LabelsElement(p),
  points: (p: ElementParams<'points'>) => new PointsElement(p),
} as const;

/**
 * Type map from element names to their instance types.
 */
export type ElementInstanceMap = {
  [K in ElementName]: ReturnType<(typeof elementFactories)[K]>;
};

/**
 * Union of all element types.
 */
export type AnyElement = ElementInstanceMap[ElementName];

/**
 * Union of spatial element types (excludes tables).
 */
export type SpatialElement = ElementInstanceMap[Exclude<ElementName, 'tables'>];

/**
 * Create an element instance for a given element type.
 *
 * @param name - The element type ('tables', 'shapes', 'images', 'labels', 'points')
 * @param sdata - The SpatialData properties
 * @param key - The element key within the SpatialData object
 * @returns A typed element instance
 */
export function createElement<T extends ElementName>(
  name: T,
  sdata: SDataProps,
  key: string
): ElementInstanceMap[T] {
  // Cast needed because TypeScript can't correlate the generic T with the factory map lookup
  // See: https://github.com/microsoft/TypeScript/issues/30581
  const factory = elementFactories[name] as unknown as (
    p: ElementParams<T>
  ) => ElementInstanceMap[T];
  return factory({ sdata, name, key });
}

/**
 * Load all elements of a given type from a SpatialData object.
 *
 * @param sdata - The SpatialData properties
 * @param name - The element type to load
 * @returns A record mapping element keys to element instances
 */
export function loadElements<T extends ElementName>(
  sdata: SDataProps,
  name: T
): Record<string, ElementInstanceMap[T]> | undefined {
  const { tree } = sdata.rootStore;
  if (!tree) {
    throw new Error('Tree store contents not available');
  }
  if (!(name in tree)) {
    return undefined;
  }

  const keys = Object.keys(tree[name] as object);
  if (keys.length === 0) {
    return undefined;
  }

  const result: Record<string, ElementInstanceMap[T]> = {};
  for (const key of keys) {
    try {
      result[key] = createElement(name, sdata, key);
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      if (sdata.onBadFiles) {
        sdata.onBadFiles(`${name}/${key}`, normalizedError);
      } else {
        console.error(normalizedError);
      }
    }
  }
  return result;
}

// Re-export types that may be useful externally
export type { RasterAttrs, ShapesAttrs, PointsAttrs, CoordinateTransformation };
