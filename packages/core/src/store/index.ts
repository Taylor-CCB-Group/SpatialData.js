/**
 * Store interface for reading SpatialData from zarr stores
 */

import * as zarr from 'zarrita';
import { getTransformation } from '../transformations';
import { parseStoreContents, serializeZarrTree, tryConsolidated } from './zarrUtils';
import { loadElement } from '../models';
import type { 
  ElementName, 
  XSpatialElement, 
  StoreLocation, 
  BadFileHandler,
  ZGroup,
  ZarrTree
} from '../types';
import { SpatialElementNames, ElementNames } from '../types';


/*
In Python, we have

class Elements(UserDict[str, T])
  ...
class Images(Elements[DataArray | DataTree])
class Labels(Elements[DataArray | DataTree])
class Shapes(Elements[GeoDataFrame])
class Points(Elements[DaskDataFrame])
class Tables(Elements[AnnData])

*/

// these should be things with easy to access properties for lazy loading (partial) data
// not the zarr.Group directly, but a thin wrapper, with appropriate properties for each T
// export type Tables = Record<string, ad.AnnData<zarr.Readable, zarr.NumberDataType, zarr.Uint32>>;
// we probably don't immediately invoke these, not sure if the type should be an async function or not.
// export type Elements<T extends ElementName> = Record<string, () => Promise<
// T extends 'tables' ? Table
//   : T extends 'shapes' ? Shapes : XSpatialElement>
// >;
import type { InferredElements as Elements } from '../models';

//yay typescript! so intuitive!
//this is a descriminated union type, i.e. 
// `Elements<'tables'> | Elements<'shapes'> ...`
//rather than `Elements<'tables' | 'shapes' ...>` which causes covariance issues.
export type SpatialElement = {
  [T in ElementName]: Elements<T>[string];
}[ElementName];

function repr(element: XSpatialElement) {
  if (element.kind === 'array') {
    return `shape=${element.shape}`;
  }
  // as of now, we often get empty attrs,
  // or something like `{"labels":["rasterized_016um","rasterized_008um","rasterized_002um"]}`
  // element.attrs is Record<string, unknown>
  // debugger;
  return `attrs=${JSON.stringify(element.attrs)}`;
}
async function reprA(element: XSpatialElement, name: ElementName) {
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

export class SpatialData {
  readonly url: StoreLocation;
  _ready: Promise<void>;
  // we could potentially have ListableSpatialData type...
  rootStore: zarr.Listable<zarr.FetchStore>;
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
  
  constructor(url: StoreLocation, rootStore: zarr.Listable<zarr.FetchStore>, selection?: ElementName[], onBadFiles?: BadFileHandler) {
    this.url = url;
    this.rootStore = rootStore;
    // is it a good idea to have this kind of async side-effect in the constructor?
    // maybe not, but for now making the init method private avoids accidentally not passing other arguments
    // in general, we favor use of the `readZarr` function to create and await the object
    this._ready = this._init(selection, onBadFiles);
  }
  private async _init(selection?: ElementName[], _onBadFiles?: BadFileHandler) {
    // we might use some async here for getting zattrs
    //@ts-expect-error nb adding zmetadata for typing but we may want to change that.
    this.parsed = await parseStoreContents(this.rootStore);
    const _selection = selection || ElementNames;
    for (const elementType of _selection) {
      // would prefer not to need this type annotation but at least it's not `as` etc.
      const elements: Elements<typeof elementType> = loadElement(this, elementType, _onBadFiles) || {};
      this[elementType] = elements;
    }
  }

  private* _genSpatialElementValues() {
    for (const elementType of SpatialElementNames) {
      const d = this[elementType];
      if (d) {
        // it would probably be possible to have some elementType specific generic here, but not particularly useful.
        yield* Object.values(d) as SpatialElement[];
      }
    }
  }
  get coordinateSystems() {
    // does this need to be async? probably not - working on the model for what a SpatialElement is...
    // but we should probably already have enough information about it to establish coordinate systems, for instance.
    const gen = [...this._genSpatialElementValues()];
    const allCS = new Set<string>();
    for (const obj of gen) {
      const transformations = getTransformation(obj, undefined, true);
      if (transformations instanceof Map) {
        for (const cs of transformations.keys()) {
          allCS.add(cs);
        }
      } else {
        throw new Error("Expected getTransformation to return a Map when getAll is true");
      }
    }
    return Array.from(allCS);
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

  toJSON() {
    if (!this.parsed) return this;
    return serializeZarrTree(this.parsed);
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

export async function readZarr(storeUrl: StoreLocation, selection?: ElementName[], onBadFiles?: BadFileHandler) {
  const store = new zarr.FetchStore(storeUrl);
  const listableStore = await tryConsolidated(store);
  if (!('contents' in listableStore)) {
    throw new Error("Could not list contents of the Zarr store - spatialdata stores are expected to be listable");
  }
  const sdata = new SpatialData(storeUrl, listableStore, selection, onBadFiles);
  await sdata._ready;
  return sdata;
}
