import type { ElementName, BadFileHandler, SDataProps, ZarrTree, LazyZarrArray, ZAttrsAny } from '../types';
import { ATTRS_KEY } from '../types';
import * as ad from 'anndata.js'
import * as zarr from 'zarrita';
import SpatialDataShapesSource from './VShapesSource';
import { 
  rasterAttrsSchema, 
  shapesAttrsSchema, 
  pointsAttrsSchema,
  type RasterAttrs,
  type ShapesAttrs,
  type PointsAttrs,
  type CoordinateTransformation,
  tableAttrsSchema,
  type TableAttrs,
} from '../schemas';


/**
 * Parameters for creating element instances.
 * For internal use only and subject to change.
 */
export type ElementParams<T extends ElementName = ElementName> = {
  sdata: SDataProps;
  name: T;
  key: string;
  onBadFiles?: BadFileHandler;
}

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
  readonly url: string;
  protected readonly rawAttrs: ZAttrsAny;
  protected readonly parsed: ZarrTree | LazyZarrArray<zarr.DataType>;

  constructor({ sdata, name, key }: ElementParams<T>) {
    this.kind = name;
    this.key = key;
    this.url = `${sdata.url}/${name}/${key}`;
    
    const { parsed } = sdata;
    if (!parsed) {
      throw new Error("Parsed store contents not available");
    }
    if (!(name in parsed)) {
      throw new Error(`Unknown element type: ${name}`);
    }
    const p1 = parsed[name] as ZarrTree;
    if (!(key in p1)) {
      throw new Error(`Unknown element key: ${key}`);
    }
    this.parsed = p1[key];
    this.rawAttrs = (p1[key] as ZarrTree)[ATTRS_KEY] as ZAttrsAny ?? {};
  }
}

/**
 * Base class for spatial elements (everything except tables).
 * Spatial elements have coordinate transformations.
 */
abstract class AbstractSpatialElement<
  TKind extends Exclude<ElementName, 'tables'>,
  TAttrs
> extends AbstractElement<TKind> {
  abstract readonly attrs: TAttrs;
  
  /**
   * Subclasses must implement this to provide access to their coordinate transformations.
   * Different element types store transforms in different locations.
   */
  protected abstract get rawCoordinateTransformations(): CoordinateTransformation | undefined;
  
  /**
   * Get coordinate transformations for this element.
   * @param toCoordinateSystem - Optional target coordinate system name.
   *   If not provided, returns all transformations for this element.
   * @returns The transformations, or undefined if not available
   */
  getTransformations(toCoordinateSystem?: string): CoordinateTransformation | undefined {
    const transforms = this.rawCoordinateTransformations;
    
    if (!transforms || transforms.length === 0) {
      return undefined;
    }
    
    // If no target specified, return all transformations
    if (!toCoordinateSystem) {
      return transforms;
    }
    
    // Filter to transformations with matching output coordinate system
    const matching = transforms.filter(t => {
      const output = (t as { output?: { name?: string } }).output;
      return output?.name === toCoordinateSystem;
    });
    
    return matching.length > 0 ? matching : undefined;
  }
  
  /**
   * Get all coordinate system mappings for this element.
   * Groups transformations by their output coordinate system name.
   * @returns A Map from output coordinate system name to transformations
   */
  getAllTransformations(): Map<string, CoordinateTransformation> {
    const result = new Map<string, CoordinateTransformation>();
    const transforms = this.rawCoordinateTransformations;
    
    if (!transforms) return result;
    
    for (const t of transforms) {
      const output = (t as { output?: { name?: string } }).output;
      const outputName = output?.name ?? 'global';
      
      const existing = result.get(outputName);
      if (existing) {
        result.set(outputName, [...existing, t]);
      } else {
        result.set(outputName, [t]);
      }
    }
    
    return result;
  }
}

// ============================================
// Table Element (non-spatial)
// ============================================

/**
 * Element representing an AnnData table.
 * Tables don't have spatial transformations.
 */
export class TableElement extends AbstractElement<'tables'> {
  readonly attrs: TableAttrs;
  
  constructor(params: ElementParams<'tables'>) {
    super(params);
    // parse attrs through schema
    const result = tableAttrsSchema.safeParse(this.rawAttrs);
    if (!result.success) {
      console.warn(`Schema validation failed for ${params.name}/${params.key}:`, result.error.issues);
      this.attrs = this.rawAttrs as TableAttrs;
    } else {
      this.attrs = result.data;
    }
  }
  
  /**
   * Load the table as an AnnData.js object.
   */
  async getAnnDataJS(): Promise<ad.AnnData<zarr.Readable<unknown>, zarr.NumberDataType, zarr.Uint32>> {
    return await ad.readZarr(new zarr.FetchStore(this.url));
  }
}

// ============================================
// Raster Elements (images & labels)
// ============================================

/**
 * Base class for raster elements (images and labels).
 * These share OME-NGFF multiscale structure and transformation logic.
 */
abstract class RasterElement<T extends 'images' | 'labels'> extends AbstractSpatialElement<T, RasterAttrs> {
  readonly attrs: RasterAttrs;
  
  constructor(params: ElementParams<T>) {
    super(params);
    
    // Parse attrs through schema
    const result = rasterAttrsSchema.safeParse(this.rawAttrs);
    if (!result.success) {
      console.warn(`Schema validation failed for ${params.name}/${params.key}:`, result.error.issues);
      // Fall back to raw attrs cast - allows working with non-conformant data
      this.attrs = this.rawAttrs as RasterAttrs;
    } else {
      this.attrs = result.data;
    }
  }
  
  /**
   * Get the spatial axes from the first multiscale definition.
   */
  get spatialAxes() {
    return this.attrs.multiscales[0]?.axes.filter(a => a.type === 'space') ?? [];
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
    return this.attrs.multiscales[0]?.datasets.map(d => d.path) ?? [];
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
  getTransformationsForLevel(level: number | string, toCoordinateSystem?: string) {
    const datasets = this.attrs.multiscales[0]?.datasets ?? [];
    const dataset = typeof level === 'number' 
      ? datasets[level] 
      : datasets.find(d => d.path === level);
    
    if (!dataset) return undefined;
    
    return {
      element: this.getTransformations(toCoordinateSystem),
      dataset: dataset.coordinateTransformations,
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
 */
export class LabelsElement extends RasterElement<'labels'> {
  // Labels-specific methods can be added here
  // e.g., colormap, associated table lookup, etc.
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
      console.warn(`Schema validation failed for shapes/${params.key}:`, result.error.issues);
      this.attrs = this.rawAttrs as ShapesAttrs;
    } else {
      this.attrs = result.data;
    }
    
    // Initialize the Vitessce-derived shapes source for loading geometry
    this.vShapes = new SpatialDataShapesSource({ 
      store: new zarr.FetchStore(this.url), 
      fileType: '.zarr' 
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
    return this.vShapes.loadPolygonShapes(`${this.url}/geometry`);
  }
  
  /**
   * Load circle/point geometry data.
   */
  async loadCircleShapes() {
    return this.vShapes.loadCircleShapes(`${this.url}/geometry`);
  }
  
  /**
   * Load the shapes index.
   */
  async loadShapesIndex() {
    return this.vShapes.loadShapesIndex(`shapes/${this.key}`);
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
  
  constructor(params: ElementParams<'points'>) {
    super(params);
    
    // Parse attrs through schema
    const result = pointsAttrsSchema.safeParse(this.rawAttrs);
    if (!result.success) {
      console.warn(`Schema validation failed for points/${params.key}:`, result.error.issues);
      this.attrs = this.rawAttrs as PointsAttrs;
    } else {
      this.attrs = result.data;
    }
  }
  
  /**
   * Transformations are at attrs.coordinateTransformations with input/output refs.
   */
  protected get rawCoordinateTransformations(): CoordinateTransformation | undefined {
    return this.attrs.coordinateTransformations;
  }
  
  // Points-specific loading methods can be added here
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
  const factory = elementFactories[name] as unknown as (p: ElementParams<T>) => ElementInstanceMap[T];
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
  const { parsed } = sdata;
  if (!parsed) {
    throw new Error("Parsed store contents not available");
  }
  if (!(name in parsed)) {
    return undefined;
  }
  
  const keys = Object.keys(parsed[name] as object);
  if (keys.length === 0) {
    return undefined;
  }
  
  const result: Record<string, ElementInstanceMap[T]> = {};
  for (const key of keys) {
    result[key] = createElement(name, sdata, key);
  }
  return result;
}

// Re-export types that may be useful externally
export type { RasterAttrs, ShapesAttrs, PointsAttrs, CoordinateTransformation };
