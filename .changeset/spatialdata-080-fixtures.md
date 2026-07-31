---
'@spatialdata/core': patch
'@spatialdata/vis': patch
---

Track spatialdata 0.8.0 in the fixture matrix; README quick-starts now point at
`test-fixtures/v0.8.0/blobs.zarr`.

No source changes — 0.8.0 reads correctly today. It does change the store on disk
in two ways worth knowing about, both now covered by the integration matrix:

- multiscale dataset paths are `s0`/`s1`/`s2` rather than `0`/`1`/`2`, so level
  names must come from `multiscales[0].datasets[].path` and never from position;
- the AnnData `obs`/`var` index is written as a `nullable-string-array` *group*
  (a `values` array beside a `mask` array) instead of a plain `string-array`
  array. `loadObsIndex()` and the table source's `loadVarIndex()` both decode it.

Note that `anndata.js`'s `varNames()` cannot read the new index at all — read var
names through the table source, not the AnnData wrapper.
