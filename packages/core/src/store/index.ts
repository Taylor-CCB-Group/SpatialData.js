/**
 * Store interface for reading SpatialData from zarr stores
 */

import * as zarr from 'zarrita';
import * as ad from 'anndata.js'
import { getTransformation } from '../transformations';
import { type ZGroup, type ZarrTree, parseStoreContents } from './zarrUtils';
import SpatialDataShapesSource from '../models/VShapesSource';
// import type { SpatialData } from '../schemas/index.js';
// import { spatialDataSchema } from '../schemas/index.js';

type StoreLocation = string | URL;

export const SpatialElementNames = ['images', 'points', 'labels', 'shapes'] as const;
export const ElementNames = [...SpatialElementNames, 'tables'] as const;
export type ElementName = typeof ElementNames[number];


/*
Not the actual type we want
In Python, we have

class Elements(UserDict[str, T])
  ...
class Images(Elements[DataArray | DataTree])
class Labels(Elements[DataArray | DataTree])
class Shapes(Elements[GeoDataFrame])
class Points(Elements[DaskDataFrame])
class Tables(Elements[AnnData])



*/

export type SpatialElement = Awaited<ReturnType<typeof zarr.open>>;


// these should be things with easy to access properties for lazy loading (partial) data
// not the zarr.Group directly, but a thin wrapper, with appropriate properties for each T
// export type Tables = Record<string, ad.AnnData<zarr.Readable, zarr.NumberDataType, zarr.Uint32>>;
export type Table = ad.AnnData<zarr.Readable<unknown>, zarr.NumberDataType, zarr.Uint32>;
export type Shapes = Awaited<ReturnType<typeof SpatialDataShapesSource.prototype.loadPolygonShapes>>;
// we probably don't immediately invoke these, not sure if the type should be an async function or not.
export type Elements<T extends ElementName> = Record<string, () => Promise<
T extends 'tables' ? Table
  : T extends 'shapes' ? Shapes : SpatialElement>>;
  // 'tables': Record<string, ad.AnnData<zarr.Readable, zarr.NumberDataType, zarr.Uint32>>;
  // 'images': Record<string, SpatialElement>;
  // 'points': Record<string, SpatialElement>;
  // 'labels': Record<string, SpatialElement>;
  // 'shapes': Record<string, SpatialElement>;


function repr(element: SpatialElement) {
  if (element.kind === 'array') {
    return `shape=${element.shape}`;
  }
  // as of now, we often get empty attrs,
  // or something like `{"labels":["rasterized_016um","rasterized_008um","rasterized_002um"]}`
  // element.attrs is Record<string, unknown>
  // debugger;
  return `attrs=${JSON.stringify(element.attrs)}`;
}

async function reprA(element: SpatialElement, name: ElementName) {
  if (name === 'labels') {
    const { labels } = element.attrs;
    const labelsArr = Array.isArray(labels) ? labels : (typeof labels === 'string' ? [labels] : []);
    const x = await Promise.all(labelsArr.map(async (label) => {
      try {
        const labelElem = await zarr.open(element.resolve(label));
        return `      ${label}: ${repr(labelElem)}`;
      } catch (error) {
        return `      ${label}: could not open (${error})`;
      }
    }));
    return x.join('\n');
  }
  console.log(element);
  return repr(element);
}

// we might not always use the FetchStore, this is for convenience & could change

/**
 * There is a tendency for .zmetadata to be misnamed as zmetadata...
 */
async function tryConsolidated(store: zarr.FetchStore) {
  return zarr.withConsolidated(store).catch(() => zarr.tryWithConsolidated(store, { metadataKey: 'zmetadata' }));
}
/**
 * This can be expanded so that it has a generic for ElementName, with some more specific validation and typing.
 */
async function loadElement(root: ZGroup, name: ElementName, onBadFiles?: BadFileHandler) {
  try {
    const element = await zarr.open(root.resolve(name), { kind: 'group' });
    return element;
  } catch (error) {
    if (onBadFiles && error instanceof Error) {
      onBadFiles(name, error);
    }
    return undefined;
  }
}
export class SpatialData {
  readonly url: StoreLocation;
  _ready: Promise<void>;
  // we could potentially have ListableSpatialData type...
  private _listableStore?: zarr.Listable<zarr.FetchStore>;
  private _root?: ZGroup;

  images?: Elements<'images'>;
  points?: Elements<'points'>;
  labels?: Elements<'labels'>;
  shapes?: Elements<'shapes'>;
  tables?: Elements<'tables'>;

  /**
   * Keeping this for experimenting with this structure vs AnnData.js for Tables etc.
   */
  parsed?: ZarrTree;
  
  constructor(url: StoreLocation, selection?: ElementName[], onBadFiles?: BadFileHandler) {
    this.url = url;
    // is it a good idea to have this kind of async side-effect in the constructor?
    // maybe not, but for now making the init method private avoids accidentally not passing other arguments
    // in general, we favor use of the `readZarr` function to create and await the object
    this._ready = this._init(selection, onBadFiles);
  }
  private async _init(selection?: ElementName[], _onBadFiles?: BadFileHandler) {
    const store = new zarr.FetchStore(this.url);
    const listableStore = await tryConsolidated(store);
    const root = await zarr.open(store, { kind: 'group' });
    this._root = root;
    if ('contents' in listableStore) {
      console.log("contents", listableStore.contents()); // we could do something with this
      this._listableStore = listableStore;
      this.parsed = parseStoreContents(listableStore, root);
      if (this.parsed.tables) {
        this.tables = {};
        for (const [key] of Object.entries(this.parsed.tables)) {
          // not sure we want these immediately invoked or not.
          this.tables[key] = (async () => {
            // I don't think anndata.js has a function for reading a whole anndata object from a path within a store?
            // so we need a new store for each one?
            const store = await tryConsolidated(new zarr.FetchStore(`${this.url}/tables/${key}`));
            const adata = await ad.readZarr(store);
            return adata;
          });
          // break;
        }
      }
      // we should be looking up these loaders in a dictionary maybe.
      // source of truth for element types could then be derived from that.
      if (this.parsed.shapes) {
        this.shapes = {};
        for (const [key] of Object.entries(this.parsed.shapes)) {
          this.shapes[key] = (async () => {
            // maybe we can use the root store - and remember the path... that seems like the type we need.
            // const store = await tryConsolidated(new zarr.FetchStore(`${this.url}/shapes/${key}`));
            const shapes = new SpatialDataShapesSource({ store, fileType: '.zarr' });
            // we definitely don't want to be immediately invoking a thing that loads data here...
            console.log('loading polygon shapes for', `shapes/${key}`);
            // is this always known to be the right path?
            // in vitessce there is a `getGeometryPath` function that returns `${path}/geometry`
            // so that supports the notion that it is.s
            const polygonShapes = await shapes.loadPolygonShapes(`shapes/${key}/geometry`);
            console.log('polygonShapes', polygonShapes);
            return polygonShapes;
          });
        }
      }
    } else {
      throw new Error("Could not list contents of the Zarr store - for now, we only support listable Zarr stores");
    }
  }

  private* _genSpatialElementValues() {
    for (const elementType of SpatialElementNames) {
      const d = this[elementType];
      if (d) {
        yield* Object.values(d);
      }
    }
  }
  get coordinateSystems() {
    // does this need to be async?
    return new Promise<string[]>(resolve => {
      const gen = [...this._genSpatialElementValues()];
      const allCS = new Set<string>();
      Promise.all(gen.map(async (obj) => {
        const transformations = getTransformation(await obj, undefined, true);
        // nb, should we be more consistent about Map vs Record?
        if (transformations instanceof Map) {
          for (const cs of transformations.keys()) {
            allCS.add(cs);
          }
        } else {
          throw new Error("Expected getTransformation to return a Map when getAll is true");
        }
      })).then(() => {
        resolve(Array.from(allCS));
      });
    });
  }
  /**
   * Generates a string representation of the SpatialData object, similar to the Python `__repr__` method.
   * 
   * As `toString()` cannot be async, this may have limited information; {@link representation} may be able
   * to get more detailed info.
   */
  toString() {
    const nonEmptyElements = ElementNames.filter((name) => this[name] !== undefined);
    if (nonEmptyElements.length === 0) {
      return `SpatialData object, with asssociated Zarr store: ${this.url}\n(No elements loaded)`;
    }
    const elements = nonEmptyElements.map((name) => {
      const element = this[name];
      if (element) {
        // return `  └── ${name}:\n      └── ${repr(element)}`;
        return Object.entries(element).map(([key, val]) => `  └── ${name}/${key}:\n      └── ${repr(val)}`).join('\n');
      }
      return `- ${name}: not loaded`;
    }).join('\n');
    // to do this properly, there are async calls involved... we can't really leak async into `toString`
    // so we probably have another method for deeper inspection
    // const cs = `with coordinate systems: ${this.coordinateSystems.join(', ')}`;
    return `SpatialData object, with asssociated Zarr store: ${this.url}\nElements:\n${elements}`;
  }
  
  async representation() {
    await this._ready;

    if (this.parsed) {
      return JSON.stringify(this.parsed, null, 2);
    }

    const nonEmptyElements = ElementNames.filter((name) => this[name] !== undefined);
    if (nonEmptyElements.length === 0) {
      return `SpatialData object, with asssociated Zarr store: ${this.url}\n(No elements loaded)`;
    }
    const elements = (await Promise.all(nonEmptyElements.map(async (name) => {
      const element = this[name];
      if (element) {
        //return `  └── ${name}:\n      └── ${await reprA(element, name)}`; 
        // return `  └── ${name}:\n      └── ${repr(element)}`;
        return Object.entries(element).map(([key, val]) => `  └── ${name}/${key}:\n      └── ${repr(val)}`).join('\n');
      }
      return `- ${name}: not loaded`;
    }))).join('\n');
    // to do this properly, there are async calls involved... we can't really leak async into `toString`
    // so we probably have another method for deeper inspection
    const cs = `with coordinate systems: ${(await this.coordinateSystems).join(', ')}`;
    return `SpatialData object, with asssociated Zarr store: ${this.url}\nElements:\n${elements},\n${cs}`;
  }
}

export type BadFileHandler = (file: string, error: Error) => void;

export async function readZarr(storeUrl: StoreLocation, selection?: ElementName[], onBadFiles?: BadFileHandler) {
  const sdata = new SpatialData(storeUrl, selection, onBadFiles);
  await sdata._ready;
  return sdata;
}
