/**
 * Store interface for reading SpatialData from zarr stores
 */

import type * as zarr from 'zarrita';
import { getTransformation } from '../transformations';
import {type ConsolidatedStore, openExtraConsolidated, serializeZarrTree } from '@spatialdata/zarrextra';
import { loadElements, type ElementInstanceMap, type SpatialElement } from '../models';
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
  rootStore: ConsolidatedStore;
  // metadata: Record<string, unknown>; //todo: add this, with type (validated by zod)

  images?: Elements<'images'>;
  points?: Elements<'points'>;
  labels?: Elements<'labels'>;
  shapes?: Elements<'shapes'>;
  tables?: Elements<'tables'>;

  constructor(url: StoreLocation, rootStore: ConsolidatedStore, selection?: ElementName[], onBadFiles?: BadFileHandler) {
    this.url = url;
    this.rootStore = rootStore;
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
    try {
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
      return `SpatialData object, with associated Zarr store: ${this.url}\nElements:\n${elements}\n${cs}`;
    } catch (error) {
      // this can happen if `this.coordinateSystems` trips over some invalid `attrs` where we did a bad `as Whatever` after validation fails...
      // without the catch we get a really nasty crash.
      // nb - we now don't allow elements to exist if the schema doesn't validate, but wouldn't be too suprised if we end up back here at some point...
      // will inevitably have some SNAFU somewhere.
      // sorry future code user/maintainer if that is so.
      return `Corrupt SpatialData.toString(): '${error}'`
    }
  }

  toJSON() {
    if (!this.rootStore.tree) return this;
    return serializeZarrTree(this.rootStore.tree);
  }
}

export async function readZarr(storeUrl: StoreLocation, selection?: ElementName[], onBadFiles?: BadFileHandler) {
  // todo: this should be able to handle a store directly, not just a url
  // then there are some downstream changes required for the models/loaders etc.
  // rather than `tryConsolidated` here, lets have some `zarrextra` function instead.
  const result = await openExtraConsolidated(storeUrl);
  if (result.ok) {
    return new SpatialData(storeUrl, result.value, selection, onBadFiles);
  }
  throw new Error(`${result.error}`);
}
