import type { ElementName, Table, BadFileHandler, SDataProps } from '../types';
import * as ad from 'anndata.js'
import * as zarr from 'zarrita';
import { tryConsolidated } from '../store/zarrUtils';
import SpatialDataShapesSource from './VShapesSource';

/**
 * For internal use only and subject to change.
 * Maybe passing sdata isn't the right thing to do.
 */
export type LoaderParams<T extends ElementName> = {
  sdata: SDataProps;
  name: T;
  key: string;
  onBadFiles?: BadFileHandler;
}
function tableLoader({ sdata, name, key }: LoaderParams<'tables'>) {
  if (name !== "tables") {
    //type of `name` is `never` here and this should be unreachable, we don't ever expect to see this.
    throw new Error(`Expected 'tables', got '${name}' - something went wrong in the type system for '${name}/${key}'`);
  }
  const url = `${sdata.url}/${name}/${key}`;
  let loaded: Promise<Table> | undefined;
  // these things that we return should just be a function returning a promise 
  // - it should be a thing with enough useful information as we have without having to fetch anything else,
  // - and a way of fetching the actual data when we need it.
  return async () => {
    if (!loaded) {
      // do we want to use AnnData.js here, or the Vitessce implementation in SpatialDataTableSource?
      loaded = tryConsolidated(new zarr.FetchStore(url)).then(store => ad.readZarr(store));
    }
    return loaded;
  }
}

function shapesLoader({ sdata, name, key }: LoaderParams<'shapes'>) {
  const url = `${sdata.url}/${name}/${key}`;
  return async () => {
    const shapes = new SpatialDataShapesSource({ store: new zarr.FetchStore(url), fileType: '.zarr' });
    // shapes.elementAttrs
    // this is very much not the right thing - we don't just want the geometry,
    // and we need to be careful about how much geometry we load, etc.
    // We don't want to act like Shapes are AnnData, but also not just geometry.
    // we very much want to be able to conveniently access the attributes before thinking about loading any geometry.
    // and then we want sensible ways of getting the bits of geometry we need when we want to do that.
    const polygonShapes = await shapes.loadPolygonShapes(`${url}/geometry`);
    return polygonShapes;
  }
}

function defaultLoader({ sdata, name, key }: LoaderParams<'images' | 'labels' | 'points'>) {
  const url = `${sdata.url}/${name}/${key}`;
  return async () => {
    const element = await zarr.open(new zarr.FetchStore(url), { kind: 'group' });
    return element;
  }
}

// nb - we can make it so that this is the source of truth for Elements<K>
// so the Elements<K> type is derived from this rather than the other way around.
// i.e. as we flesh out/change the implementations of the loaders it will reflect that reality.
// type ElementLoaders = {
//   [K in ElementName]: (params: LoaderParams<K>) => Elements<K>[K]
// }
// const elementLoaders: ElementLoaders = {
//   tables: tableLoader,
//   shapes: shapesLoader,
//   images: defaultLoader,
//   labels: defaultLoader,
//   points: defaultLoader,
// } as const;

// Loader functions for each element type
// nb - still trying to figure out the nicest thing to be returning from any given loader
// not implementing much concrete behaviour while I fiddle with that.
const elementLoaders = {
  tables: tableLoader,
  shapes: shapesLoader,
  images: defaultLoader,
  labels: defaultLoader,
  points: defaultLoader,
} as const;

// Type inference for the resolved element types
type Loaders<K extends ElementName> = {
  [K in ElementName]: (typeof elementLoaders)[K];
}[K];


function getLoader<T extends ElementName>(name: T): Loaders<T> {
  const loader = elementLoaders[name];
  if (!loader) {
    // this is not expected to happen, some flawed logic if it does.
    throw new Error(`Unknown element type: ${name}`);
  }
  return loader;
}


type InferredElementsA<K extends ElementName> = {
  [K in ElementName]: Record<string, ReturnType<Loaders<K>>>;
}[K];
type InferredElementsB<T extends ElementName> =
Record<string, ReturnType<Loaders<T>>>;

//these are both the same type
//type TablesA = InferredElementsA<'tables'>
//type TablesB = InferredElementsB<'tables'>
//these are different
//type TA = InferredElementsA<ElementName>;
//type TB = InferredElementsB<ElementName>;
//even with ['tables'] this is some horrible union thing
// type TD = InferredElementsB<ElementName>['tables'];
// using this version for now but this whole thing is getting ridiculous.
export type InferredElements<T extends ElementName> = InferredElementsB<T>;

/**
 * Returns a record of strings to SpatialElements for a given element type in a given SpatialData object.
 */
export function loadElement<T extends ElementName>(
  sdata: SDataProps, 
  name: T, 
  onBadFiles?: BadFileHandler
) {
  const { parsed } = sdata;
  if (!parsed) {
    throw new Error("Parsed store contents not available");
  }
  if (!(name in parsed)) {
    return {};
  }
  // const loader = elementLoaders[name];
  // if (!loader) {
  //   throw new Error(`Unknown element type: ${name}`);
  // }
  // const result: InferredElements<T> = {};
  // for (const [key] of Object.entries(parsed[name])) {
  //   // @ts-expect-error - typescript rabbit hole.
  //   result[key] = loader({ sdata, name, key, onBadFiles });
  // }
  // return result;

  // ended up with this unrolled for now because of T not working how I'd like...
  // maybe I should run away and join a circus instead, this programming thing may not be for me.
  if (name === 'tables') {
    const result: InferredElements<'tables'> = {};
    for (const [key] of Object.entries(parsed[name])) {
      result[key] = elementLoaders.tables({ sdata, name, key, onBadFiles });
    }
    return result;
  }
  if (name === 'shapes') {
    const result: InferredElements<'shapes'> = {};
    for (const [key] of Object.entries(parsed[name])) {
      result[key] = elementLoaders.shapes({ sdata, name, key, onBadFiles });
    }
    return result;
  }
  if (name === 'images') {
    const result: InferredElements<'images'> = {};
    for (const [key] of Object.entries(parsed[name])) {
      result[key] = elementLoaders.images({ sdata, name, key, onBadFiles });
    }
    return result;
  }
  if (name === 'labels') {
    const result: InferredElements<'labels'> = {};
    for (const [key] of Object.entries(parsed[name])) {
      result[key] = elementLoaders.labels({ sdata, name, key, onBadFiles });
    }
    return result;
  }
  if (name === 'points') {
    const result: InferredElements<'points'> = {};
    for (const [key] of Object.entries(parsed[name])) {
      result[key] = elementLoaders.points({ sdata, name, key, onBadFiles });
    }
    return result;
  }
}



export async function getTableKeys(element: Table) {

}
