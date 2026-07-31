---
'@spatialdata/core': minor
---

Read AnnData's nullable-encoded columns, and report their kind.

A nullable column is a **group** of `values` + `mask`, not an array, so opening its
path as an array fails outright. The visible symptom is usually a missing *index*
rather than a missing value, because `obs/_index` and `var/_index` are ordinary
columns — a table would load with `varN` in place of gene names, or with no row ids.
This is not a legacy shape to tolerate: AnnData 0.13 defaults to zarr v3 and writes
string columns this way by default, `_index` included, so it is what a freshly
written `spatialdata` store looks like.

All three nullable encodings are read (`nullable-string-array`, `nullable-integer`,
`nullable-boolean`), with the mask honoured — a masked entry decodes as `null`, which
the missing-value handling already treats as absent, so it stays distinguishable from
a real `0` or `''` rather than being silently rendered as one.

`getObsColumnKinds` recognises the same three. Without this the kind lookup fell
through to array metadata that a group does not have and returned `undefined`,
sending `'auto'` mode back to sniffing decoded values for exactly the columns AnnData
now writes by default — the case that lookup exists to avoid.

Also fixes zarr v3 categoricals decoding to their raw integer codes. The categories
array is written as `string` on v3, and the text check tested for one v2 spelling of
that dtype (`v2:object`), so the column resolved to codes — plausible-looking numbers
rather than an error. The check now asks zarrita whether the dtype is text, which
covers v3 `string` and v2 `U`/`S` alike, and pandas' `-1` missing code maps to `null`
instead of indexing off the end of the categories.
