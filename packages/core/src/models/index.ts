import type { ElementName, Table, BadFileHandler, SpatialData, Elements } from '../store';
import * as ad from 'anndata.js'
import * as zarr from 'zarrita';
import { tryConsolidated } from '../store/zarrUtils';
import SpatialDataShapesSource from './VShapesSource';

/**
 * For internal use only and subject to change.
 * Maybe passing sdata isn't the right thing to do.
 */
export type LoaderParams<T extends ElementName> = {
  sdata: SpatialData;
  name: T;
  key: string;
  onBadFiles?: BadFileHandler;
}

function tableLoader({ sdata, name, key }: LoaderParams<'tables'>) {
  const url = `${sdata.url}/${name}/${key}`;
  let loaded: Promise<Table> | undefined;
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
type ElementLoaders = {
  [K in ElementName]: (params: LoaderParams<K>) => Elements<K>[K]
}
const elementLoaders: ElementLoaders = {
  tables: tableLoader,
  shapes: shapesLoader,
  images: defaultLoader,
  labels: defaultLoader,
  points: defaultLoader,
} as const;

//// unused, but with a bit more refactor, this can be used in place of elementLoaders
//// and we should be able to mostly infer the types we want from this.
const elLoaders = {
  tables: tableLoader,
  shapes: shapesLoader,
  images: defaultLoader,
  labels: defaultLoader,
  points: defaultLoader,
} as const;

// - not equivalent to Elements<K> because it refers to the individual element
// not the "records strings to functions that return elements asynchronously" (hence all the Awaited<ReturnType<ReturnType<...>>>).
type El<K extends ElementName> = typeof elLoaders[K];
type InferedElements<K extends ElementName> = Awaited<ReturnType<ReturnType<El<K>>>>;
type S = InferedElements<'shapes'>;
// type S = {
//   shape: [number, null];
//   data: [number, number][][][];
// }
// ... which is not what we actually want, but it's what we currently have - and it comes from inference, not some imposed type.
// so if we base things on these inferred types, we should be able to experiment with the value returned by the loader
// and have that type properly reflected in the types we use throughout the code.
type T = InferedElements<'tables'>;


/**
 * Returns a record of strings to SpatialElements for a given element type in a given SpatialData object.
 */
export function loadElement<T extends ElementName>(sdata: SpatialData, name: T, onBadFiles?: BadFileHandler) {
  const loader = elementLoaders[name];
  if (!loader) {
    throw new Error(`Unknown element type: ${name}`);
  }
  const { parsed } = sdata;
  if (!parsed) {
    throw new Error("Parsed store contents not available");
  }
  if (!(name in parsed)) {
    return undefined;
  }
  const result: Elements<T> = {};
  for (const [key] of Object.entries(parsed[name])) {
    result[key] = loader({ sdata, name, key, onBadFiles });
  }
  return result;
}



export async function getTableKeys(element: Table) {

}
