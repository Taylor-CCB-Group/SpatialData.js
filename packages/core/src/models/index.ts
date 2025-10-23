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
  let loaded: Table | undefined;
  return async () => {
    if (loaded) {
      return loaded;
    }
    const store = await tryConsolidated(new zarr.FetchStore(url));
    loaded = await ad.readZarr(store);
    return loaded;
  }
}

function shapesLoader({ sdata, name, key }: LoaderParams<'shapes'>) {
  const url = `${sdata.url}/${name}/${key}`;
  return async () => {
    const shapes = new SpatialDataShapesSource({ store: new zarr.FetchStore(url), fileType: '.zarr' });
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

const elementLoaders: {
  // nb - we might make it so that this is the source of truth for Elements<K>
  // so the Elements<K> type is derived from this rather than the other way around.
  // i.e. as we flesh out/change the implementations of the loaders it will reflect that reality.
  [K in ElementName]: (params: LoaderParams<K>) => Elements<K>[K]
} = {
  tables: tableLoader,
  shapes: shapesLoader,
  images: defaultLoader,
  labels: defaultLoader,
  points: defaultLoader,
} as const;

/**
 * Returns records of strings to SpatialElements
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
