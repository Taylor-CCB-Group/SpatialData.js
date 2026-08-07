---
'@spatialdata/layers': minor
'@spatialdata/vis': minor
---

Make a column's colours a property of the column, not of the features that loaded.

Three things decided the encoding from whatever happened to be in view, so two
layers over one annotation could disagree about what a colour means — which reads
as a data difference rather than as a bug:

- Category indices were assigned in **first-seen feature order**. A shapes layer
  walks the loader's geometry order and a labels layer walks the raster's ids, so
  the same `cell_type` column rendered in two different schemes on the two kinds.
  (`labelColorEncoding.spec.ts` claimed to cover this, but only pinned the indices
  on one kind; it now actually builds the column through both.) Categories are now
  ordered by value, with numeric-looking values ordered numerically so cluster 10
  follows cluster 9 rather than cluster 1.
- Positional palettes cannot survive a category being **absent from a view** at
  all: `tumour` genuinely is the second category present when `stroma` is not.
  `categoricalPalette` therefore also accepts `{ byValue: { Tumour: [200, 30, 30] } }`,
  with an optional `fallback` for values it does not name (`'oklab'` by default, so
  an unnamed category keeps its own hue instead of merging into one bucket). This
  is the form to prefer in a saved stack, and the only form an embedding
  application can use to make a layer agree with its own charts.
- The continuous ramp measured its extent from the loaded features. `numericDomain`
  pins it to the column's own range; values outside clamp rather than extrapolate.

`featureColorSchemeSignature` now takes the scheme as one object
(`featureColorSchemeSignature(config.fillColorByColumn)`) rather than three
positional arguments, so adding a term to the encoding cannot leave a call site
silently keying on the old set — the failure mode there being a layer that keeps
serving the previous colours after the scheme changed. Named palettes are
serialised in sorted key order, since object key order is insertion order and a
host rebuilding its palette each render need not insert in a stable one.

**Colours will change** for existing categorical configs that relied on the
implicit first-seen order. Pass `categoricalPalette: { byValue }` to fix a scheme
in place.
