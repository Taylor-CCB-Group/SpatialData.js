---
'@spatialdata/core': minor
'@spatialdata/layers': minor
'@spatialdata/vis': minor
---

Decide continuous vs categorical from the column's declared kind, and let callers
configure missing values.

`TableElement.loadObsColumnKinds` reports what the store says each obs column is —
`numeric`, `categorical`, `string` or `boolean` — and `loadAssociatedTableFeatureRows`
carries it alongside the values as `extraColumnKinds`. `'auto'` mode now trusts that in
preference to sniffing stringified values, which was wrong at both edges: one `NaN` made a
float column look non-numeric, and integer cluster codes looked like a continuum. Value
sniffing remains only as the fallback when no kind is available.

`fillColorByColumn.missingValues` configures the rest: `treatAsMissing` adds
store-specific sentinel strings (`'NA'`, `'unknown'`, …) that only the caller can
recognise, and `render` chooses whether a feature with no value keeps the layer default,
is hidden, or takes an explicit colour. `null` and `NaN` are always missing and are not
configurable. Sentinels are excluded before the mode decision, the numeric extent and the
category set, so a sentinel never becomes a category or drags a ramp.
