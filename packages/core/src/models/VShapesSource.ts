// This started as a direct copy of the Vitessce implementation, with changes
// mostly to make it more normal TypeScript.
// ref: https://github.com/vitessce/vitessce/blob/main/packages/file-types/spatial-zarr/src/SpatialDataShapesSource.js
//
// Divergences from upstream are intentional and should stay easy to audit:
// - TypeScript normalization / typing cleanup throughout.
// - `getShapesFormatVersion()` treats modern `ngff:shapes` metadata revisions
//   as compatible with the parquet-backed code path rather than hard-coding a
//   single post-0.1 version string. This is currently needed so high-level
//   feature-id loading (`ShapesElement.loadFeatureIds()`) works for newer
//   SpatialData stores.
//
// Planned evolution:
// - keep this file narrowly focused on geometry / feature-id loading
// - avoid growing more app-facing policy here
// - if we continue diverging from Vitessce, document each change explicitly in
//   `docs/docs/core/internals.mdx`

import WKB from 'ol/format/WKB.js';
import { basename } from '../Vutils';
// import { log } from '@vitessce/globals';
const log = console;

// import SpatialDataTableSource from './SpatialDataTableSource.js';

import type { Table as ArrowTable } from 'apache-arrow';
import type { Vector } from 'apache-arrow/vector';
import type { Chunk, NumberDataType, TypedArray as ZarrTypedArray } from 'zarrita';
import type { SpatialBounds } from '../pointsTiling.js';
import type { ShapesGeometryKind, ShapesRenderData } from '../shapes';
import SpatialDataTableSource from './VTableSource';
export type PolygonShape = Array<Array<[number, number]>>;
//nb, not totally happy with this type.
export type ZarrNumericArray = ZarrTypedArray<NumberDataType> | BigInt64Array | Array<number>;

export interface ShapesInBoundsOptions {
  bounds: SpatialBounds;
  zoom?: number;
  signal?: AbortSignal;
  columns?: string[];
}

export type ShapesInBoundsResult = ShapesRenderData & {
  bounds: SpatialBounds;
  loadMode: 'full-filter';
};

// If the array path starts with table/something/rest
// capture table/something.

const shapesElementRegex = /^shapes\/([^/]*)$/;
const shapesSubElementRegex = /^shapes\/([^/]*)\/(.*)$/;

function getShapesElementPath(arrPath?: string) {
  if (arrPath) {
    const matches = arrPath.match(shapesSubElementRegex);
    if (matches && matches.length === 3) {
      return `shapes/${matches[1]}`;
    }
    const elementMatches = arrPath.match(shapesElementRegex);
    if (elementMatches && elementMatches.length === 2) {
      return `shapes/${elementMatches[1]}`;
    }
  }
  return ''; // TODO: throw an error?
}

function getIndexPath(arrPath?: string) {
  return `${getShapesElementPath(arrPath)}/Index`;
}

function getParquetPath(arrPath?: string) {
  const elementPrefix = getShapesElementPath(arrPath);
  if (elementPrefix.startsWith('shapes/')) {
    return `${elementPrefix}/shapes.parquet`;
  }
  throw new Error(`Cannot determine parquet path for shapes array path: ${arrPath}`);
}

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException('The operation was aborted.', 'AbortError');
  }
}

/**
 * Converts BigInt64Array or Float64Array to Float32Array if needed.
 * TODO: remove this and support BigInts/Float64s in downstream code.
 * @param input - The typed array to convert.
 * @returns The converted or original Float32Array.
 */
/** GeoPandas parquet metadata stored under Arrow schema key `geo`. */
export interface GeopandasGeoParquetMetadata {
  primary_column?: string;
  columns?: Record<
    string,
    {
      encoding?: string;
      geometry_types?: string[];
    }
  >;
}

/** WKB geometry type names that decode to a single [x, y] per feature row. */
const POINT_ONLY_WKB_GEOMETRY_TYPES = new Set(['Point']);

function normalizeGeometryTypes(value: unknown): string[] | null {
  if (typeof value === 'string') {
    return [value];
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const types = value.filter((item): item is string => typeof item === 'string');
  return types.length > 0 ? types : null;
}

function parseGeopandasGeoParquetMetadata(raw: unknown): GeopandasGeoParquetMetadata | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const primaryColumn = record.primary_column;
  if (typeof primaryColumn !== 'string') {
    return null;
  }
  const columns = record.columns;
  if (typeof columns !== 'object' || columns === null) {
    return null;
  }
  const columnMeta = (columns as Record<string, unknown>)[primaryColumn];
  if (typeof columnMeta !== 'object' || columnMeta === null) {
    return null;
  }
  const geometryTypes = normalizeGeometryTypes(
    (columnMeta as Record<string, unknown>).geometry_types
  );
  if (!geometryTypes) {
    return null;
  }
  const encoding = (columnMeta as Record<string, unknown>).encoding;
  return {
    primary_column: primaryColumn,
    columns: {
      [primaryColumn]: {
        ...(typeof encoding === 'string' ? { encoding } : {}),
        geometry_types: geometryTypes,
      },
    },
  };
}

export function readGeopandasGeoParquetMetadata(
  arrowTable: ArrowTable
): GeopandasGeoParquetMetadata | null {
  const raw = arrowTable.schema.metadata.get('geo');
  if (!raw) {
    return null;
  }
  try {
    return parseGeopandasGeoParquetMetadata(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function inferShapesGeometryKindFromParquet(arrowTable: ArrowTable): ShapesGeometryKind {
  if (arrowTable.schema.fields.some((field) => field.name === 'radius')) {
    return 'circle';
  }

  const geo = readGeopandasGeoParquetMetadata(arrowTable);
  const primaryColumn = geo?.primary_column ?? 'geometry';
  const geometryTypes = geo?.columns?.[primaryColumn]?.geometry_types ?? [];
  if (
    geometryTypes.length > 0 &&
    geometryTypes.every((type) => POINT_ONLY_WKB_GEOMETRY_TYPES.has(type))
  ) {
    return 'point';
  }

  return 'polygon';
}

function featureIdsFromIndex(
  indexRaw: ArrayLike<unknown> | null | undefined,
  rowCount: number
): string[] {
  if (indexRaw) {
    return Array.from(indexRaw, (value: unknown) => String(value));
  }
  return Array.from({ length: rowCount }, (_, index) => String(index));
}

function toFloat32Array(input: ZarrNumericArray): Float32Array {
  if (input instanceof Float32Array) {
    return input; // Already a Float32Array
  }

  if (input instanceof BigInt64Array) {
    const floats = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) {
      floats[i] = Number(input[i]); // May lose precision
    }
    return floats;
  }

  if (input instanceof Float64Array) {
    return new Float32Array(input); // Converts with reduced precision
  }

  if (Array.isArray(input)) {
    return new Float32Array(input);
  }

  log.warn('toFloat32Array expected Float32Array, Float64Array, BigInt64Array, or Array input');
  return new Float32Array(input);
}

export default class SpatialDataShapesSource extends SpatialDataTableSource {
  /**
   *
   * @param path A path to within shapes.
   * @returns The format version / compatibility mode used for this shapes element.
   */
  async getShapesFormatVersion(path: string): Promise<'0.1' | '0.2'> {
    const zattrs = await this.loadSpatialDataElementAttrs(path);
    const formatVersion = zattrs.spatialdata_attrs?.version;
    const geos = zattrs.spatialdata_attrs.geos || {}; // Used only by v0.1
    const encodingType = zattrs['encoding-type'];
    if (encodingType !== 'ngff:shapes') {
      throw new Error(
        `Unexpected encoding type or version for shapes spatialdata_attrs: ${encodingType} ${formatVersion}`
      );
    }

    if (formatVersion === '0.1') {
      if (geos.name === 'POINT' && geos.type === 0) {
        return '0.1';
      }
      throw new Error(
        `Unexpected encoding type or version for shapes spatialdata_attrs: ${encodingType} ${formatVersion}`
      );
    }

    // Modern shapes elements are parquet-backed. Historically we only matched
    // one specific version string here, but tooltip/feature-id lookup should
    // work across newer ngff:shapes metadata revisions as long as the parquet
    // layout is present. Route them through the same code path as 0.2.
    //
    // This is a deliberate divergence from the original Vitessce helper. The
    // high-level API contract we care about is "can we load stable feature
    // ids?", not "does the metadata version string equal one exact value?".
    return '0.2';
  }

  /**
   * Whether this shapes element stores polygons, circles (point + radius), or point landmarks.
   */
  async getShapesGeometryKind(elementPath: string): Promise<ShapesGeometryKind> {
    const formatVersion = await this.getShapesFormatVersion(elementPath);
    if (formatVersion === '0.1') {
      const zattrs = await this.loadSpatialDataElementAttrs(elementPath);
      const geos = zattrs.spatialdata_attrs?.geos || {};
      if (geos.name === 'POINT' && geos.type === 0) {
        return 'point';
      }
      throw new Error(
        `Unsupported legacy shapes geometry for ${elementPath}: ${JSON.stringify(geos)}`
      );
    }

    const parquetPath = getParquetPath(elementPath);
    const arrowTable = await this.loadParquetTable(parquetPath);
    return inferShapesGeometryKindFromParquet(arrowTable);
  }

  /**
   * Class method for loading general numeric arrays.
   * @param path A string like obsm.X_pca.
   * @returns A promise for a zarr array containing the data.
   */
  async loadNumeric(path: string): Promise<Chunk<NumberDataType>> {
    const elementPath = getShapesElementPath(path);
    const formatVersion = await this.getShapesFormatVersion(elementPath);
    if (formatVersion === '0.1') {
      // Shapes v0.1 did not use Parquet, so we use the parent Zarr-based column loading function.
      const zarrArr = await super.loadNumeric(path);
      // TODO: move BigInt conversion into superclass
      return {
        stride: zarrArr.stride,
        shape: zarrArr.shape,
        data: toFloat32Array(zarrArr.data),
      };
    }
    const parquetPath = getParquetPath(path);
    const columnName = basename(path);
    const columns = [columnName];
    const arrowTable = await this.loadParquetTable(parquetPath, columns);
    const columnArr = arrowTable.getChild(columnName)?.toArray();
    return {
      shape: [columnArr.length],
      // TODO: support other kinds of TypedArrays via @vitessce/arrow-utils.
      data: toFloat32Array(columnArr),
      stride: [1],
    };
  }

  /**
   * Helper to get geometry column from Arrow table and check type.
   * @param arrowTable
   * @param columnName
   * @returns
   */
  _getGeometryColumn(arrowTable: ArrowTable, columnName: string): Vector {
    const geometryColumn = arrowTable.getChild(columnName);
    if (!geometryColumn) {
      throw new Error(`Column ${columnName} not found in parquet table`);
    }
    if (geometryColumn.type.toString() !== 'Binary') {
      throw new Error(
        `Expected geometry column to have Binary type but got ${geometryColumn.type.toString()}`
      );
    }
    return geometryColumn;
  }

  /**
   * Helper to check if geometry column is WKB encoded.
   * @param {import('apache-arrow').Table} arrowTable
   * @param {string} columnName
   * @returns {boolean}
   */
  _isWkbColumn(arrowTable: ArrowTable, columnName: string) {
    // From GeoPandas.to_parquet docs:
    // "By default, all geometry columns present are serialized to WKB format in the file"
    // Reference: https://geopandas.org/en/stable/docs/reference/api/geopandas.GeoDataFrame.to_parquet.html
    // TODO: support geoarrow serialization schemes in addition to WKB.

    // Check if the column has metadata indicating it is WKB encoded.
    // Reference: https://github.com/geopandas/geopandas/blob/6ab5a7145fa788d049a805f114bc46c6d0ed4507/geopandas/io/arrow.py#L172
    const geometryEncodingValue = arrowTable.schema.fields
      .find((field) => field.name === columnName)
      ?.metadata?.get('ARROW:extension:name');

    if (!geometryEncodingValue) {
      // This may occur if the Parquet file was written by pre-1.0.0 geopandas,
      // which neither included the metadata nor supported alternative encodings.
      // Reference: https://github.com/vitessce/vitessce/issues/2265
      return true;
    }
    return geometryEncodingValue === 'geoarrow.wkb';
  }

  /**
   * Helper to decode WKB geometry column as flat coordinates (for points).
   * @param geometryColumn
   * @returns Array of [x, y] coordinates.
   */
  _decodeWkbColumnFlat(geometryColumn: Vector): Array<[number, number]> {
    const wkb = new WKB();
    const arr = geometryColumn.toArray();
    return arr.map((geom: ArrayBuffer) => {
      const coords = (
        wkb.readGeometry(geom) as unknown as { getFlatCoordinates: () => Array<number | bigint> }
      ).getFlatCoordinates();
      return [Number(coords[0]), Number(coords[1])] as [number, number];
    });
  }

  /**
   * Helper to decode WKB geometry column as nested coordinates (for polygons).
   * @param geometryColumn
   * @returns Array of polygons, each as array of [x, y] pairs.
   */
  _decodeWkbColumnNested(geometryColumn: Vector): Array<Array<Array<[number, number]>>> {
    const wkb = new WKB();
    const arr = geometryColumn.toArray();
    // For polygons: getCoordinates returns nested arrays

    // TODO: alternatively, use positionFormat: 'XY' and return flat coordinates again.
    // However this may complicate applying transformations, at least in the current way.
    // Reference: https://deck.gl/docs/api-reference/layers/polygon-layer#data-accessors
    return arr.map((geom: ArrayBuffer) => {
      const coords = wkb
        .readGeometry(geom)
        // @ts-expect-error - getCoordinates is not a method of Geometry, check this<<<
        .getCoordinates();
      // Take first polygon (if multipolygon)
      return coords[0];
    });
  }

  /**
   *
   * @param elementPath
   * @returns Array of any, or null.
   */
  async loadShapesIndex(elementPath: string) {
    //TODO: PJT - better return type for this.
    const formatVersion = await this.getShapesFormatVersion(elementPath);
    if (formatVersion === '0.1') {
      // Shapes v0.1 did not use Parquet, so we use the parent Zarr-based column loading function.
      return this._loadColumn(getIndexPath(elementPath));
    }

    const parquetPath = getParquetPath(elementPath);
    const indexColumn = await this.loadParquetTableIndex(parquetPath);
    if (indexColumn) {
      return indexColumn.toArray();
    }
    return null;
  }

  /**
   *
   * @param path
   * @returns A promise for a zarr array containing the data.
   */
  async loadPolygonShapes(path: string) {
    const columnName = basename(path);
    const parquetPath = getParquetPath(path);
    const arrowTable = await this.loadParquetTable(parquetPath);
    const geometryColumn = this._getGeometryColumn(arrowTable, columnName);
    if (this._isWkbColumn(arrowTable, columnName)) {
      // If the geometry column is WKB encoded, decode it.
      const polygons = this._decodeWkbColumnNested(geometryColumn);
      // Return polygons as a ragged array.
      return {
        shape: [polygons.length, null] as [number, null], // Ragged array
        data: polygons,
      };
    }
    throw new Error('Unexpected encoding type for polygons, currently only WKB is supported');
  }

  async loadShapesRenderData(elementPath: string): Promise<ShapesRenderData> {
    const formatVersion = await this.getShapesFormatVersion(elementPath);
    const elementKey = getShapesElementPath(elementPath).replace(/^shapes\//, '');

    if (formatVersion === '0.1') {
      const zattrs = await this.loadSpatialDataElementAttrs(elementPath);
      const geos = zattrs.spatialdata_attrs?.geos || {};
      if (geos.name === 'POINT' && geos.type === 0) {
        throw new Error(
          `Legacy ngff:shapes 0.1 point geometry is unsupported for render loading at ${elementPath}. Migrate to parquet-backed shapes (0.2+).`
        );
      }
      throw new Error(
        `Unsupported legacy shapes geometry for ${elementPath}: ${JSON.stringify(geos)}`
      );
    }

    const parquetPath = getParquetPath(elementPath);
    // loadParquetTable caches the parsed Arrow table, so the three calls below
    // (here, inside loadShapesIndex, inside loadPolygonShapes / loadCircleShapes)
    // share one WASM decode.
    const geometryTable = await this.loadParquetTable(parquetPath);
    const geometryKind = inferShapesGeometryKindFromParquet(geometryTable);

    if (geometryKind === 'circle' || geometryKind === 'point') {
      const [featureIdsRaw, circleResult] = await Promise.all([
        this.loadShapesIndex(elementPath),
        this.loadCircleShapes(`${elementPath}/geometry`),
      ]);
      const [xs, ys] = circleResult.data;
      const featureIds = featureIdsFromIndex(featureIdsRaw, xs.length);
      if (featureIds.length !== xs.length || featureIds.length !== ys.length) {
        throw new Error(
          `Feature id count (${featureIds.length}) did not match point geometry count (${xs.length}) for ${elementPath}`
        );
      }

      let radii: Float32Array | undefined;
      if (geometryKind === 'circle') {
        const radiiResult = await this.loadNumeric(`${elementPath}/radius`);
        radii = toFloat32Array(radiiResult.data);
        if (featureIds.length !== radii.length) {
          throw new Error(
            `Feature id count (${featureIds.length}) did not match radius count (${radii.length}) for ${elementPath}`
          );
        }
      }

      // geometryTable is not retained in the return value for wkb-parquet paths:
      // all geometry has been decoded into typed arrays above, and keeping a
      // second copy of the full Arrow table would waste heap memory.
      return {
        kind: 'wkb-parquet',
        geometryKind,
        elementKey,
        featureIds,
        circles: { positions: [xs, ys], radii },
        geometryColumnName: 'geometry',
        rowIndexByFeatureIndex: new Int32Array(featureIds.length).fill(-1),
      };
    }

    const [featureIdsRaw, polygonResult] = await Promise.all([
      this.loadShapesIndex(elementPath),
      this.loadPolygonShapes(`${elementPath}/geometry`),
    ]);
    const polygons = polygonResult.data;
    const featureIds = featureIdsFromIndex(featureIdsRaw, polygons.length);
    if (featureIds.length !== polygons.length) {
      throw new Error(
        `Feature id count (${featureIds.length}) did not match polygon count (${polygons.length}) for ${elementPath}`
      );
    }

    // geometryTable is not retained for the same reason as the circle path above.
    return {
      kind: 'wkb-parquet',
      geometryKind: 'polygon',
      elementKey,
      featureIds,
      polygons,
      geometryColumnName: 'geometry',
      rowIndexByFeatureIndex: new Int32Array(featureIds.length).fill(-1),
    };
  }

  async loadShapesInBounds(
    elementPath: string,
    options: ShapesInBoundsOptions
  ): Promise<ShapesInBoundsResult> {
    checkAbort(options.signal);
    const renderData = await this.loadShapesRenderData(elementPath);
    checkAbort(options.signal);
    return {
      ...renderData,
      bounds: options.bounds,
      loadMode: 'full-filter',
    };
  }

  /**
   *
   * @param path
   * @returns A promise for a zarr array containing the data.
   */
  async loadCircleShapes(path: string) {
    const columnName = basename(path);
    const parquetPath = getParquetPath(path);

    // TODO: specify columns here. TODO: also include the radius column if needed.
    // TODO: refactor to not load the table twice when radius is needed.

    const arrowTable = await this.loadParquetTable(parquetPath);
    const geometryColumn = this._getGeometryColumn(arrowTable, columnName);
    if (this._isWkbColumn(arrowTable, columnName)) {
      // If the geometry column is WKB encoded, decode it.
      const points = this._decodeWkbColumnFlat(geometryColumn);
      // Return flat coordinates as a 2D array.
      return {
        shape: [2, points.length],
        data: [toFloat32Array(points.map((p) => p[0])), toFloat32Array(points.map((p) => p[1]))],
      };
    }
    throw new Error('Unexpected encoding type for circles, currently only WKB is supported');
  }
}
