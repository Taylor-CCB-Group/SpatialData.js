import { open as zarrOpen, get as zarrGet } from 'zarrita';
import { dirname } from '../Vutils';
import ZarrDataSource from './VZarrDataSource';
import type { DataSourceParams } from '../Vutils';



function prependSlash(path: string) {
  if (typeof path === 'string' && path.length >= 1) {
    if (path.charAt(0) === '/') {
      // No prepending needed.
      return path;
    }
    return `/${path}`;
  }
  return path;
}

/**
 * A base AnnData loader which has all shared methods for more complex loaders,
 * like loading cell names and ids. It inherits from AbstractLoader.
 */
export default class AnnDataSource extends ZarrDataSource {
  promises: Map<string, Promise<string[] | string[][] | undefined>>;
  obsIndex?: Promise<string[]>;
  varIndex?: Promise<string[]>;
  varAlias?: string[];
  constructor(params: DataSourceParams) {
    super(params);
    this.promises = new Map();
  }

  /**
   *
   * @param paths Paths to multiple string-valued columns
   * within the obs dataframe.
   * @returns each column as an array of strings, ordered the same as the paths.
   */
  loadObsColumns(paths: string[] | string[][]) {
    return this._loadColumns(paths);
  }

  /**
   *
   * @param paths Paths to multiple string-valued columns
   * within the var dataframe.
   * @returns each column as an array of strings, ordered the same as the paths.
   */
  loadVarColumns(paths: string[] | string[][]) {
    return this._loadColumns(paths);
  }

  /**
   * Class method for loading obs variables.
   * Takes the location as an argument because this is shared across objects,
   * which have different ways of specifying location.
   * @param {string[] | string[][]} paths An array of strings like
   * "obs/leiden" or "obs/bulk_labels."
   * @returns {Promise<(undefined | string[] | string[][])[]>} A promise
   * for an array of ids with one per cell.
   */
  _loadColumns(paths: string[] | string[][]) {
    const promises = paths.map((path) => {
      const getCol = (col: string): Promise<string[]> => {
        if (!this.promises.has(col)) {
          const obsPromise = this._loadColumn(col).catch((err) => {
            // clear from cache if promise rejects
            this.promises.delete(col);
            // propagate error
            throw err;
          });
          this.promises.set(col, obsPromise);
        }
        return this.promises.get(col) as Promise<string[]>;
      };
      if (!path) {
        return Promise.resolve(undefined);
      }
      if (Array.isArray(path)) {
        return Promise.resolve(Promise.all(path.map(getCol)));
      }
      return getCol(path);
    });
    return Promise.all(promises);
  }

  /**
   *
   * @param {string} pathOrig
   * @returns
   */
  async _loadColumn(pathOrig: string) {
    const { storeRoot } = this;

    const path = prependSlash(pathOrig);
    const prefixOrig = dirname(path);
    const prefix = prependSlash(prefixOrig);
    const { categories, 'encoding-type': encodingType } = await this.getJson(`${path}/.zattrs`);
    let categoriesValues: string[] | undefined;
    let codesPath: string | undefined;
    if (categories) {
      const { dtype } = await zarrOpen(
        storeRoot.resolve(`${prefix}/${categories}`),
        { kind: 'array' },
      );
      //@ts-expect-error this seems to incorrect in the vitessce code? '|O' is not a valid dtype.
      if (dtype === 'v2:object' || dtype === '|O') {
        categoriesValues = await this.getFlatArrDecompressed(
          `${prefix}/${categories}`,
        );
      }
    } else if (encodingType === 'categorical') {
      const { dtype } = await zarrOpen(
        storeRoot.resolve(`${path}/categories`),
        { kind: 'array' },
      );

      //@ts-expect-error this seems to incorrect in the vitessce code? '|O' is not a valid dtype.
      if (dtype === 'v2:object' || dtype === '|O') {
        categoriesValues = await this.getFlatArrDecompressed(
          `${path}/categories`,
        );
      }
      codesPath = `${path}/codes`;
    } else if (encodingType === 'string-array') {
      return this.getFlatArrDecompressed(path);
    } else {
      const { dtype } = await zarrOpen(
        storeRoot.resolve(path),
        { kind: 'array' },
      );
      //@ts-expect-error this seems to incorrect in the vitessce code? '|O' is not a valid dtype.
      if (dtype === 'v2:object' || dtype === '|O') {
        return this.getFlatArrDecompressed(path);
      }
    }
    const arr = await zarrOpen(
      storeRoot.resolve(codesPath || path),
      { kind: 'array' },
    );
    const values = await zarrGet(arr, [null]);
    const { data } = values;
    const mappedValues = Array.from(data).map(
      i => (!categoriesValues ? String(i) : categoriesValues[i as number]),
    );
    return mappedValues;
  }

  /**
   * Class method for loading general numeric arrays.
   * @param path A string like obsm.X_pca.
   * @returns A promise for a zarr array containing the data.
   */
  async loadNumeric(path: string) {
    const { storeRoot } = this;
    return zarrOpen(storeRoot.resolve(path), { kind: 'array' })
      .then(arr => zarrGet(arr));
  }

  /**
   * Class method for loading specific columns of numeric arrays.
   * @param path A string like obsm.X_pca.
   * @param dims The column indices to load.
   * @returns {Promise<{
   *  data: [ZarrTypedArray<any>, ZarrTypedArray<any>],
   *  shape: [number, number],
   * }>} A promise for a zarr array containing the data.
   */
  async loadNumericForDims(path: string, dims: [number, number]) {
    const { storeRoot } = this;
    const arr = zarrOpen(storeRoot.resolve(path), { kind: 'array' });
    return Promise.all(
      dims.map(dim => arr.then(
        loadedArr => zarrGet(loadedArr, [null, dim]),
      )),
    ).then(cols => ({
      data: /** @type {[ZarrTypedArray<any>, ZarrTypedArray<any>]} */ (
        cols.map(col => col.data)
      ),
      shape: [dims.length, cols[0].shape[0]],
    }));
  }

  /**
   * A common method for loading flattened data
   * i.e that which has shape [n] where n is a natural number.
   * @param path A path to a flat array location, like obs/_index
   * @returns The data from the zarr array.
   */
  async getFlatArrDecompressed(path: string) {
    const { storeRoot } = this;
    const arr = await zarrOpen(storeRoot.resolve(path), { kind: 'array' });
    // Zarrita supports decoding vlen-utf8-encoded string arrays.
    const data = await zarrGet(arr);
    if (data.data?.[Symbol.iterator]) {
      return Array.from(data.data) as string[];
    }
    return data.data as string[];
  }

  /**
   * Class method for loading the obs index.
   * @param {string|undefined} path Used by subclasses.
   * @returns {Promise<string[]>} An promise for a zarr array
   * containing the indices.
   */
  loadObsIndex(path?: string) {
    if (this.obsIndex) {
      return this.obsIndex;
    }
    this.obsIndex = this.getJson('obs/.zattrs')
      .then(({ _index }) => this._loadColumn(`/obs/${_index}`));
    return this.obsIndex;
  }

  /**
   * Class method for loading the obs index.
   * @param {string|undefined} path Used by subclasses.
   * @returns {Promise<string[]>} An promise for a zarr array
   * containing the indices.
   */
  loadDataFrameIndex(
    // eslint-disable-next-line no-unused-vars
    path = undefined,
  ) {
    const dfPath = path ? dirname(path) : '';
    return this.getJson(`${dfPath}/.zattrs`)
      .then(({ _index }) => this._loadColumn(`${dfPath.length > 0 ? '/' : ''}${dfPath}/${_index}`));
  }

  /**
   * Class method for loading the var index.
   * @param {string|undefined} path Used by subclasses.
   * @returns {Promise<string[]>} An promise for a zarr array containing the indices.
   */
  loadVarIndex(
    // eslint-disable-next-line no-unused-vars
    path = undefined,
  ) {
    if (this.varIndex) {
      return this.varIndex;
    }
    this.varIndex = this.getJson('var/.zattrs')
      .then(({ _index }) => this._loadColumn(`/var/${_index}`));
    return this.varIndex;
  }

  /**
   * Class method for loading the var alias.
   * @param {string} varPath
   * @param {string|undefined} matrixPath
   * @returns {Promise<string[]>} An promise for a zarr array containing the aliased names.
   */
  async loadVarAlias(
    varPath: string,
    matrixPath?: string,
  ) {
    if (this.varAlias) {
      return this.varAlias;
    }
    //@ts-expect-error what is this??
    [this.varAlias] = await this.loadVarColumns([varPath]);
    if (!this.varAlias) {
      throw new Error('Failed to load var alias');
    }
    const index = await this.loadVarIndex();
    this.varAlias = this.varAlias.map(
      (val, ind) => (val ? val.concat(` (${index[ind]})`) : index[ind]),
    );
    return this.varAlias;
  }

  /**
   *
   * @param {string} path
   * @returns {Promise<object>}
   */
  async _loadAttrs(path: string) {
    return this.getJson(`${path}/.zattrs`);
  }

  /**
   *
   * @param {string} path
   * @returns {Promise<string>}
   */
  async _loadString(path: string) {
    const { storeRoot } = this;
    const zattrs = await this._loadAttrs(path);
    if ('encoding-type' in zattrs && 'encoding-version' in zattrs) {
      const {
        'encoding-type': encodingType,
        'encoding-version': encodingVersion,
      } = zattrs;

      if (encodingType === 'string' && encodingVersion === '0.2.0') {
        const arr = await zarrOpen(storeRoot.resolve(path), { kind: 'array' });
        // TODO: Use zarrGet once it supports zero-dimensional array access.
        const { data } = await arr.getChunk([]);
        //@ts-expect-error we might be able to use a zarrita type-guard here?
        return data.get(0);
      }
      throw new Error(`Unsupported encoding type ${encodingType} and version ${encodingVersion} in AnnDataSource._loadString`);
    }
    throw new Error('Keys for encoding-type or encoding-version not found in AnnDataSource._loadString');
  }

  /**
   *
   * @param {string} path
   * @returns {Promise<string[]>}
   */
  async _loadStringArray(path: string) {
    const zattrs = await this._loadAttrs(path);
    if ('encoding-type' in zattrs && 'encoding-version' in zattrs) {
      const { 'encoding-type': encodingType, 'encoding-version': encodingVersion } = zattrs;

      if (encodingType === 'string-array' && encodingVersion === '0.2.0') {
        return this.getFlatArrDecompressed(path);
      }
      throw new Error(`Unsupported encoding type ${encodingType} and version ${encodingVersion} in AnnDataSource._loadStringArray`);
    }
    throw new Error('Keys for encoding-type or encoding-version not found in AnnDataSource._loadString');
  }

  /**
   *
   * @param {string} path
   * @returns
   */
  async _loadElement(path: string) {
    const zattrs = await this._loadAttrs(path);
    if ('encoding-type' in zattrs) {
      const { 'encoding-type': encodingType } = zattrs;
      if (encodingType === 'string') {
        return this._loadString(path);
      } if (encodingType === 'string-array') {
        return this._loadStringArray(path);
      }
    }
    // TODO: support more elements
    return null;
  }

  /**
   *
   * @param {string} path
   * @param {string[]} keys
   * @returns
   */
  async _loadDict(path: string, keys: string[]) {
    const zattrs = await this._loadAttrs(path);
    if ('encoding-type' in zattrs && 'encoding-version' in zattrs) {
      const {
        'encoding-type': encodingType,
        'encoding-version': encodingVersion,
      } = zattrs;

      if (encodingType === 'dict' && encodingVersion === '0.1.0') {
        /** @type {{ [k: string]: string|string[]|null|undefined }} */
        const result: Record<string, string | string[] | null | undefined> = {};
        await Promise.all(keys.map(async (key) => {
          let val: string | string[] | null | undefined;
          try {
            val = await this._loadElement(`${path}/${key}`);
          } catch (e) {
            console.error(`Error in _loadDict: could not load ${key}`);
          }
          result[key] = val;
        }));
        return result;
      }
      throw new Error(`Unsupported encoding type ${encodingType} and version ${encodingVersion} in AnnDataSource._loadDict`);
    }
    throw new Error('Keys for encoding-type or encoding-version not found in AnnDataSource._loadString');
  }
}
