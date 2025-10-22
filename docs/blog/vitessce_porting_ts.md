# Notes on ported Vitessce code, TypeScript etc.

A lot of the Vitessce code is written in `.js` files with `// @ts-check` and quite extensive type-annotations in `jsdoc` form.

While moving the code across, I've been been changing this so that it is more regular TypeScript - which has mostly been a fairly straightforward process, and I think the result is somewhat cleaner... but some of these changes are also intermingled with what should be very minor changes to functionality - the change of a `return null` to just `return` where another function was assinging the returned value to something annotated as 'optional' for example. I also noticed the mechanism for `getParquetModule` was being used in a way that would cause it to be re-fetched for instantiation of `SpatialDataTableSource` - I think the pattern used may have been following the way I'd implemented [importing openjpeg-wasm in this draft viv PR](https://github.com/hms-dbmi/viv/pull/903), which I now notice I haven't updated with the equivalent of [how I changed this in MDV](https://github.com/Taylor-CCB-Group/MDV/commit/4caeb4a8c435c64de3ab929284cd75fa1e7eff68).

I don't *think* I've done anything that should intefere with functionality - but I've been through this process before adopting any actual tests or uses of the underlying code in any active code-path. I've circled the sun enough times to be very wary of assuming that everything will be fine without proper verification... and whether the changes are improvements or not, the fact that they exist is worth flagging.

It means that there is now the potential for the existence of two divergent implementations to exist - I believe the intention is that this library should be able to essentially stand-in for the existing implementations of `SpatialData` in Vitessce - but for that to work from their perspective would probably mean reviewing the extent to which code is ported, how it should be structured etc... The way I have so far structured things here is somewhat loose in certain ways, and I haven't (so far) comprehensively included everything that will ultimately be necessary.

## I prefer `//@ts-expect-error` to `//@ts-ignore`.

There are a few places in the code where I've left `//@ts-expect-error` annotations, with comments. I prefer this to `ts-ignore` as it means that in such cases where later changes to other parts of the code make them redundant, they then appear as errors, showing that the annotation can be removed. It's less easy to know whether a `ts-ignore` is still relevant.

## Hopefully we can make `any` history at some point.

I would definitely prefer that we can type things well enough to avoid this.

There are a few places where better use of generics on things like `Chunk<DataType>` etc would help... here is a concrete example using Zarrita's `is` to type-guard in a `loadNumeric` method:

```ts
async loadNumeric(path: string) {
  const { storeRoot } = this;
  const arr = await zarrOpen(storeRoot.resolve(path), { kind: 'array' });
  if (!arr.is("number")) {
    throw new Error(`Expected a numeric array at ${path}, but got ${arr.dtype}`);
  }
  // now we have a type-guarded array, the return type will be correctly inferred
  return await zarrGet(arr);
  // return zarrOpen(storeRoot.resolve(path), { kind: 'array' })
  //   .then(arr => zarrGet(arr));
}
```

This will change runtime behaviour in cases where the `arr.is("number")` check doesn't pass. It seems like the occassions on that would be different should only be when the underlying assumptions in the code are false, and that it will result in better error-handling, but it is also possible that there is something wrong in my understanding here.

This type design in Zarrita seems like a really good thing, encouraging the use of types in a way that properly ensures actual runtime validation is reflected in what the LSP is able to understand about the working of the code (even if the above code was written in JS, a modern editor would likely have enough information to accurately reflect the types, aside from the trivial `path: string`).

If we do end up extensively using Vitessce code in SpatialData.js, hopefully it is useful to have another pair of eyes on it - and better levereging this feature is definitely something that I advocate.

## Inheritence hierarchy - is this the right abstraction?

`class SpatialDataShapesSource extends SpatialDataTableSource` 

```ts
/**
 * This class is a parent class for tables, shapes, and points.
 * This is because these share functionality, for example:
 * - both shapes (the latest version) and points use parquet-based formats.
 * - both shapes (a previous version) and tables use zarr-based formats.
 * - logic for manipulating spatialdata element paths is shared across all elements.
 */
export default class SpatialDataTableSource extends AnnDataSource
```

This means that the interface for `Shapes` inherits everything from `AnnData`, which is not an accurate way of modelling the actual spec - there are a lot of things about `AnnData` that are not inherent to `GeoDataFrame`, which in python is what is used for `class Shapes(Elements[GeoDataFrame])`.

I find this distracting as my habbit when learning and reasoning about code tends to rely heavily on exploring what the editor thinks it 'knows' about what interface a given symbol...

I posit that the sharing of functionality between tables/points/shapes mentioned here could probably be accomplished through composition than inheritence; I haven't formulated a precise design for this just yet.

So... as I write this, on top of my local changes to rev `8ff418e` in this repository, I am investigating how the code looks if we start trying to use this `SpatialDataShapesSource` for `Elements<'shapes'>`

```ts
export type Elements<T extends ElementName> = Record<string, Promise<
T extends 'tables' ? Table
  : T extends 'shapes' ? SpatialDataShapesSource : SpatialElement>>;

...
class SpatialData {
  ...
  this.shapes[key] = (async () => {
    // we already have a store in scope at this point and want to open a path within it, but I'm not sure we're allowed?
    const store = await tryConsolidated(new zarr.FetchStore(`${this.url}/shapes/${key}`));
    return new SpatialDataShapesSource({ store, fileType: '.zarr' });
  })(); // side-note, would rather these not be immediately-invoked
}
```

When I start trying to write some hooks that access `SpatialData.shapes`, while there are undoubtedly ways of using it to get the actual data we're interested in, it is somewhat obscured by other inherited things. In order to use the `loadPolygonShapes()` method I need to know a `path` to it... 

So, working through my thought process... perhaps I should indeed be using the root `store` from the outer scope, and providing a more focused API for interfacing with the actual internal parquet data, with any relevant `path` captured within an appropriate scope - but as of this writing I seem to have a broken build, HMR not working as expected, and I think I need to get some fresh air/excercise/rest before a bit of other refactoring.