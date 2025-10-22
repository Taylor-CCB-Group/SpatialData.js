// This is a direct copy of the Vitessce implementation, with changes mostly to make it more normal TypeScript.
// ref: https://github.com/vitessce/vitessce/blob/main/packages/file-types/spatial-zarr/src/SpatialDataShapesSource.js

import WKB from 'ol/format/WKB.js';
import { basename } from '../Vutils';
// import { log } from '@vitessce/globals';
const log = console;

// import SpatialDataTableSource from './SpatialDataTableSource.js';

import type { TypedArray, Chunk, DataType } from 'zarrita';
import type { Table as ArrowTable } from 'apache-arrow';
import type { Vector } from 'apache-arrow/vector';
import SpatialDataTableSource from './VTableSource';
//type ZarrTypedArray = TypedArray<DataType>;
export type PolygonShape = Array<Array<[number, number]>>;

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

/**
 * Converts BigInt64Array or Float64Array to Float32Array if needed.
 * TODO: remove this and support BigInts/Float64s in downstream code.
 * @param input - The typed array to convert.
 * @returns The converted or original Float32Array.
 */
function toFloat32Array(input: Float32Array | BigInt64Array | Array<number>): Float32Array {
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
   * @returns The format version.
   */
  async getShapesFormatVersion(path: string): Promise<'0.1' | '0.2'> {
    const zattrs = await this.loadSpatialDataElementAttrs(path);
    const formatVersion = zattrs.spatialdata_attrs?.version;
    const geos = zattrs.spatialdata_attrs.geos || {}; // Used only by v0.1
    const encodingType = zattrs['encoding-type'];
    if (encodingType !== 'ngff:shapes' || !(
      (formatVersion === '0.1' && (geos.name === 'POINT' && geos.type === 0))
      || formatVersion === '0.2'
    )) {
      throw new Error(
        `Unexpected encoding type or version for shapes spatialdata_attrs: ${encodingType} ${formatVersion}`,
      );
    }
    return formatVersion;
  }

  /**
   * Class method for loading general numeric arrays.
   * @param path A string like obsm.X_pca.
   * @returns A promise for a zarr array containing the data.
   */
  async loadNumeric(path: string): Promise<Chunk<any>> {
    const elementPath = getShapesElementPath(path);
    const formatVersion = await this.getShapesFormatVersion(elementPath);
    if (formatVersion === '0.1') {
      // Shapes v0.1 did not use Parquet, so we use the parent Zarr-based column loading function.
      const zarrArr = await super.loadNumeric(path);
      // TODO: move BigInt conversion into superclass
      return {
        stride: zarrArr.stride,
        shape: zarrArr.shape,
        //@ts-expect-error zarrArr.data is not fully typed because the return from loadNumeric is Chunk<DataType>
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
      throw new Error(`Expected geometry column to have Binary type but got ${geometryColumn.type.toString()}`);
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
      .find(field => field.name === columnName)
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
    return arr.map(
      (geom: ArrayBuffer) => (
        // @ts-expect-error - getFlatCoordinates is not a method of Geometry, check this<<<
        (wkb.readGeometry(geom)).getFlatCoordinates()
      ),
    );
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
    return arr.map(
      (geom: ArrayBuffer) => {
        const coords = (
          // @ts-expect-error - getCoordinates is not a method of Geometry, check this<<<
          (wkb.readGeometry(geom)).getCoordinates()
        );
        // Take first polygon (if multipolygon)
        return coords[0];
      },
    );
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
        data: [
          toFloat32Array(points.map((p) => p[0])),
          toFloat32Array(points.map((p) => p[1])),
        ],
      };
    }
    throw new Error('Unexpected encoding type for circles, currently only WKB is supported');
  }
}
