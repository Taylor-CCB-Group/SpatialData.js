# Notes on ported Vitessce code, TypeScript etc.

A lot of the Vitessce code is written in `.js` files with `// @ts-check` and quite extensive type-annotations in `jsdoc` form.

While moving the code across, I've been been changing this so that it is more regular TypeScript - which has mostly been a fairly straightforward process, and I think the result is somewhat cleaner... but some of these changes are also intermingled with what should be very minor changes to functionality - the change of a `return null` to just `return` where another function was assinging the returned value to something annotated as 'optional' for example. I also noticed the mechanism for `getParquetModule` was being used in a way that would cause it to be re-fetched for instantiation of `SpatialDataTableSource` - I think the pattern used may have been following the way I'd implemented [importing openjpeg-wasm in this draft viv PR](https://github.com/hms-dbmi/viv/pull/903), which I now notice I haven't updated with the equivalent of [how I changed this in MDV](https://github.com/Taylor-CCB-Group/MDV/commit/4caeb4a8c435c64de3ab929284cd75fa1e7eff68).

I don't *think* I've done anything that should intefere with functionality - but I've been through this process before adopting any actual tests or uses of the underlying code in any active code-path. I've circled the sun enough times to be very wary of assuming that everything will be fine without proper verification... and whether the changes are improvements or not, the fact that they exist is worth flagging.

It means that there is now the potential for the existence of two divergent implementations to exist - I believe the intention is that this library should be able to essentially stand-in for the existing implementations of `SpatialData` in Vitessce - but for that to work from their perspective would probably mean reviewing the extent to which code is ported, how it should be structured etc... The way I have so far structured things here is somewhat loose in certain ways, and I haven't (so far) comprehensively included everything that will ultimately be necessary.

## I prefer `//@ts-expect-error` to `//@ts-ignore`.

There are a few places in the code where I've left `//@ts-expect-error` annotations, with comments. I prefer this to `ts-ignore` as it means that in such cases where later changes to other parts of the code make them redundant, they then appear as errors, showing that the annotation can be removed. It's less easy to know whether a `ts-ignore` is still relevant.

## Hopefully we can make `any` history at some point.

I would definitely prefer that we can type things well enough to avoid this.

There are a few places where could make better use of generics on things like `Chunk<DataType>` etc... but life is short.