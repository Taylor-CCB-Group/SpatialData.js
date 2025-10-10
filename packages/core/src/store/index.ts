/**
 * Store interface for reading SpatialData from zarr stores
 */

import * as zarr from 'zarrita';
import { getTransformation } from '../transformations';
// import type { SpatialData } from '../schemas/index.js';
// import { spatialDataSchema } from '../schemas/index.js';

type StoreLocation = string | URL;

export const SpatialElementNames = ['images', 'points', 'labels', 'shapes'] as const;
const ElementNames = [...SpatialElementNames, 'tables'] as const;
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

function parseStoreContents(store: zarr.Listable<zarr.FetchStore>) {
  const contents = store.contents().map(v => {
    const pathParts = v.path.split('/');
    // might do something with the top-level element name - ie, make a different kind of object for each

    // const elementName = pathParts[0];
    // if (!ElementNames.includes(elementName as ElementName) && pathParts.length >= 1) {
    //   console.warn(`Unexpected top-level element in SpatialData Zarr store: ${elementName}`);
    // }
    // const path = pathParts.slice(1);
      
    const path = pathParts.slice(1);
    return { path, kind: v.kind };
  }).sort((a, b) => a.path.length - b.path.length);

  // biome-ignore lint/suspicious/noExplicitAny: use any internally for building tree, at least for now
  type TreeNode = Record<string, any>;
  const tree: TreeNode = {};
  for (const item of contents) {
    let currentNode = tree;
    for (const part of item.path) {
      if (!(part in currentNode)) {
        currentNode[part] = {};
      }
      currentNode = currentNode[part];
    }
  }
  return tree;
}

// these should be things with easy to access properties for lazy loading (partial) data
// not the zarr.Group directly, but a thin wrapper, with appropriate properties for each T
export type Elements<T extends ElementName> = Record<string, SpatialElement>;

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
type ZGroup = zarr.Group<zarr.FetchStore>;

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

  images?: Elements<'images'>;
  points?: Elements<'points'>;
  labels?: Elements<'labels'>;
  shapes?: Elements<'shapes'>;
  tables?: Elements<'tables'>;
  
  constructor(url: StoreLocation, selection?: ElementName[], onBadFiles?: BadFileHandler) {
    this.url = url;
    // is it a good idea to have this kind of async side-effect in the constructor?
    // maybe not, but for now making the init method private avoids accidentally not passing other arguments
    // in general, we favor use of the `readZarr` function to create and await the object
    this._ready = this._init(selection, onBadFiles);
  }
  private async _init(selection?: ElementName[], onBadFiles?: BadFileHandler) {
    const store = new zarr.FetchStore(this.url);
    const listableStore = await tryConsolidated(store);
    if ('contents' in listableStore) {
      console.log("contents", listableStore.contents()); // we could do something with this
      this._listableStore = listableStore;
    } else {
      console.warn("Could not list contents of the Zarr store");
      //!!! we don't really want to throw here... 
      // but sometimes I want to a type-guard that we have a listable store
      // throw new Error("Could not list contents of the Zarr store");
    }
    const root = await zarr.open(store, { kind: 'group' });
    const elementsToLoad = selection ?? ElementNames;
    await Promise.allSettled([
      ...elementsToLoad.map(async (elementName) => {
        const element = await loadElement(root, elementName, onBadFiles);
        if (element) {
          //!!! tbd... this whole Promise.allSettled block will probably be replaced by a parseStoreContents variant?
          this[elementName] = { test: element };
        }
      })
    ]);
  }

  private* _genSpatialElementValues() {
    for (const elementType of SpatialElementNames) {
      const d = this[elementType];
      if (d) {
        // we may need to do something with zarrita here?
        yield* Object.values(d) as SpatialElement[]; // pseudo type safety
      }
    }
  }
  get coordinateSystems() {
    const gen = this._genSpatialElementValues();
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
    console.warn("SpatialData.coordinateSystems is not yet implemented; returning a placeholder value.");
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
    const cs = `with coordinate systems: ${this.coordinateSystems.join(', ')}`;
    return `SpatialData object, with asssociated Zarr store: ${this.url}\nElements:\n${elements},\n${cs}`;
  }
  
  async representation() {
    await this._ready;

    if (this._listableStore) {
      return JSON.stringify(parseStoreContents(this._listableStore), null, 2);
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
    const cs = `with coordinate systems: ${this.coordinateSystems.join(', ')}`;
    return `SpatialData object, with asssociated Zarr store: ${this.url}\nElements:\n${elements},\n${cs}`;
  }
}

export type BadFileHandler = (file: string, error: Error) => void;

export async function readZarr(storeUrl: StoreLocation, selection?: ElementName[], onBadFiles?: BadFileHandler) {
  const sdata = new SpatialData(storeUrl, selection, onBadFiles);
  await sdata._ready;
  return sdata;
}
