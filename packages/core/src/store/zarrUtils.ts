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
  console.log("Parsed store contents:", contents);


  const tree: ZarrTree = {};
  for (const item of contents) {
    let currentNode = tree;
    for (const part of item.path) {
      if (!(part in currentNode)) {
        // probably don't want to be over-eager with opening arrays here:
        // (and if we do, maybe for prototyping, they definitely shouldn't await sequentially)
        // there should be a value, of a type that relates to the element-type, with properties for lazily querying.
        currentNode[part] = {}; //to be over-written if it's an array leaf
      }
      if (currentNode[part] instanceof Function) {
        // this isn't expected to happen
        throw new Error(`Conflict in store contents: ${item.path.join('/')} traverses an array`);
      }
      currentNode = currentNode[part];
    }
    if (item.kind === "array") {
      // I suppose this could cache itself as well, but I'm not sure this is really for actual use
      currentNode[item.path[item.path.length - 1]] = async () => zarr.open(root.resolve(item.v.path), { kind: 'array' });
    }
  }
  return tree;
}