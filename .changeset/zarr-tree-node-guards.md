---
'zarrextra': minor
'@spatialdata/core': minor
---

Export runtime type guards and accessors for zarr tree nodes.

`ZarrTree` admits a group or a `LazyZarrArray` at every key and shipped no way to tell
them apart, so consumers hand-rolled the check — and the obvious `typeof node === 'object'`
test is wrong, because a lazy array is an object too and its own properties (`get`) then
read as child keys. `zarrextra` now exports the discrimination itself:

- `isLazyZarrArray` / `isZarrGroup` — the guards, discriminating on `ZARRAY_KEY`.
- `getChildNode` / `getChildGroup` / `getChildArray` — "the node at this path, if it is
  the kind I need", which is the shape most call sites actually want.
- `getNodeAttrs` / `getArrayMetadata` — the symbol-keyed payloads of either kind of node.
- `getArrayDtype` / `normalizeDtype` — the data type of an array node, from consolidated
  metadata alone, with v2's numpy typestrings (`<f8`, `|O`) and v3's names (`float64`,
  `string`) folded into one vocabulary: `zarrita`'s own `DataType`, so a check made
  against tree metadata and the same check made against an opened array cannot disagree.
- `isTextDataType` — "do these values need decoding to strings", covering v3 `string`,
  v2 fixed-width unicode/bytes, *and* `v2:object`. `zarrita`'s `isDataType(dtype, 'string')`
  excludes the last, and testing for one spelling without the other is what makes a
  reader hand back raw integer codes where labels were expected.

`LazyZarrArray`'s `ZARRAY_KEY` payload is typed as `ZarrArrayMetadata` instead of an
untyped record, so `dtype` and `data_type` can no longer be read without narrowing —
reading the v2 spelling off a v3 node and silently getting `undefined` stops type-checking.

`@spatialdata/core` re-exports all of the above and uses them throughout: `parsed` is
narrowed to a group once in `AbstractElement`, so no element subclass sees the union, and
`classifyObsColumnNode`, `getObsGroup` and `loadElements` drop their casts.
`AnnDataSource` now asks `isTextDataType` about an opened array's dtype, so the
classification a UI sees before loading a column and the decoding it gets when the column
loads come from one definition.

`readNullableArray`, `isNullableEncoding` and `NULLABLE_ENCODING_KINDS` are now public
too. Guards make "is this group a categorical or a nullable column?" *expressible*; those
make it *answerable* without every consumer re-deriving AnnData's on-disk layout.
