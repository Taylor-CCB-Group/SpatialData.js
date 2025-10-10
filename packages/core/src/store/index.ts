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
// http://localhost:8080/spatialdata-XETG00156__0073158__CYTO2_1NM__20250807__152057.zarr
export class SpatialData {
  readonly url: StoreLocation;
  _ready: Promise<void>;

  images?: SpatialElement;
  points?: SpatialElement;
  labels?: SpatialElement;
  shapes?: SpatialElement;
  tables?: SpatialElement;
  
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
    }
    const root = await zarr.open(store, { kind: 'group' });
    const elementsToLoad = selection ?? ElementNames;
    await Promise.allSettled([
      ...elementsToLoad.map(async (elementName) => {
        this[elementName] = await loadElement(root, elementName, onBadFiles);
      })
    ]);
  }
  /* in python:
  @property
  def coordinate_systems(self) -> list[str]:
    from spatialdata.transformations.operations import get_transformation

    all_cs = set()
    gen = self._gen_spatial_element_values()
    for obj in gen:
      transformations = get_transformation(obj, get_all=True)
      assert isinstance(transformations, dict)
    for cs in transformations:
        all_cs.add(cs)
    return list(all_cs)
  def _gen_spatial_element_values(self):
    for element_type in ["images", "labels", "points", "shapes"]:
      d = getattr(SpatialData, element_type).fget(self)
      yield from d.values()
  */
  private* _genSpatialElementValues() {
    for (const elementType of SpatialElementNames) {
      const d = this[elementType];
      if (d) {
        // we probably need to do something with zarrita here
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
        return `  └── ${name}:\n      └── ${repr(element)}`;
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
    const nonEmptyElements = ElementNames.filter((name) => this[name] !== undefined);
    if (nonEmptyElements.length === 0) {
      return `SpatialData object, with asssociated Zarr store: ${this.url}\n(No elements loaded)`;
    }
    const elements = (await Promise.all(nonEmptyElements.map(async (name) => {
      const element = this[name];
      if (element) {
        return `  └── ${name}:\n      └── ${await reprA(element, name)}`; 
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
