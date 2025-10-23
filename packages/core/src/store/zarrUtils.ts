import * as zarr from 'zarrita';

export type ZGroup = zarr.Group<zarr.FetchStore>;
export type LazyZarrArray<T extends zarr.DataType> = () => Promise<zarr.Array<T>>;
export interface ZarrTree { [key: string]: ZarrTree | LazyZarrArray<zarr.DataType>; };


/**
 * As of this writing, this returns a nested object, leaf nodes have async functions that return the zarr array.
 * 
 * This traverses arbitrary group depth etc - handy for a generic zarr thing, but for SpatialData we can have
 * something more explicitly targetting the expected structure.
 */
export function parseStoreContents(store: zarr.Listable<zarr.FetchStore>, root: ZGroup) {
  const contents = store.contents().map(v => {
    const pathParts = v.path.split('/');
    // might do something with the top-level element name - ie, make a different kind of object for each

    // const elementName = pathParts[0];
    // if (!ElementNames.includes(elementName as ElementName) && pathParts.length >= 1) {
    //   console.warn(`Unexpected top-level element in SpatialData Zarr store: ${elementName}`);
    // }
    // const path = pathParts.slice(1);
      
    const path = pathParts.slice(1);
    return { path, kind: v.kind, v };
  }).sort((a, b) => a.path.length - b.path.length).slice(1); // skip the root group itself


  const tree: ZarrTree = {};
  for (const item of contents) {
    let currentNode = tree;
    for (const [i, part] of item.path.entries()) {
      if (!(part in currentNode)) {
        // probably don't want to be over-eager with opening arrays here:
        // (and if we do, maybe for prototyping, they definitely shouldn't await sequentially)
        // there should be a value, of a type that relates to the element-type, with properties for lazily querying.
        // const leaf = i === item.path.length -1 && item.kind === "array";
        const leaf = (i === (item.path.length - 1)) && item.kind === "array";
        if (leaf) {
          // I suppose this could cache itself as well, but I'm not sure this is really for actual use
          currentNode[part] = () => zarr.open(root.resolve(item.v.path), { kind: 'array' });
        } else {
          currentNode[part] = {};
        }
      }
      // `as ZarrTree` isn't correct, but believed ok for now internally
      currentNode = currentNode[part] as ZarrTree;
    }
  }
  // console.log("Tree:", tree);
  return tree;
}
// we might not always use the FetchStore, this is for convenience & could change
/**
 * There is a tendency for .zmetadata to be misnamed as zmetadata...
 */

export async function tryConsolidated(store: zarr.FetchStore) {
  return zarr.withConsolidated(store).catch(() => zarr.tryWithConsolidated(store, { metadataKey: 'zmetadata' }));
}
