/**
 * Store interface for reading SpatialData from zarr stores
 */

import * as zarr from 'zarrita';
import { getTransformation } from '../transformations';
import { parseStoreContents, serializeZarrTree, tryConsolidated } from './zarrUtils';
import { loadElements, type ElementInstanceMap, type SpatialElement, type AnyElement } from '../models';
import type { 
  ElementName, 
  StoreLocation, 
  BadFileHandler,
  ZarrTree
} from '../types';
import { SpatialElementNames, ElementNames } from '../types';


/**
 * Type alias for element collections - maps element keys to element instances
 */
type Elements<T extends ElementName> = Record<string, ElementInstanceMap[T]>;

// Re-export SpatialElement from models
export type { SpatialElement, AnyElement } from '../models';

export class SpatialData {
  readonly url: StoreLocation;
  _ready: Promise<void>;
  rootStore: zarr.Listable<zarr.FetchStore>;
  // metadata: Record<string, unknown>; //todo: add this, with type (validated by zod)

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
      // Load all elements of this type
      // Cast needed due to TypeScript's inability to correlate generic loop variable with property access
      // See: https://github.com/microsoft/TypeScript/issues/30581
      (this as Record<ElementName, Elements<ElementName> | undefined>)[elementType] = loadElements(this, elementType);
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
      // Make this happen...
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
      return `SpatialData object, with associated Zarr store: ${this.url}\n(No elements loaded)`;
    }
    const elements = nonEmptyElements.map((name, i) => {
      const element = this[name];
      const isLast = i === nonEmptyElements.length - 1;
      const prefix = isLast ? '└──' : '├──';
      const childPrefix = isLast ? '    ' : '│   ';
      if (element) {
        const keys = Object.keys(element);
        const children = keys.map((key, j) => {
          const childIsLast = j === keys.length - 1;
          const childBranch = childIsLast ? '└──' : '├──';
          return `${childPrefix}${childBranch} ${key}`;
        }).join('\n');
        return `${prefix} ${name}:\n${children}`;
      }
      return `${prefix} ${name}: (empty)`;
    }).join('\n');
    const cs = `with coordinate systems: ${this.coordinateSystems.join(', ')}`;
    return `SpatialData object, with asssociated Zarr store: ${this.url}\nElements:\n${elements}\n${cs}`;
  }

  toJSON() {
    if (!this.parsed) return this;
    return serializeZarrTree(this.parsed);
  }
}

export async function readZarr(storeUrl: StoreLocation, selection?: ElementName[], onBadFiles?: BadFileHandler) {
  // todo: this should be able to handle a store directly, not just a url
  // then there are some downstream changes required for the models/loaders etc.
  const store = new zarr.FetchStore(storeUrl);
  const listableStore = await tryConsolidated(store);
  if (!('contents' in listableStore)) {
    throw new Error("Could not list contents of the Zarr store - spatialdata stores are expected to be listable");
  }
  const sdata = new SpatialData(storeUrl, listableStore, selection, onBadFiles);
  await sdata._ready;
  return sdata;
}
