---
'@spatialdata/layers': patch
---

Fix numeric columns being coloured as categorical when they contain `NaN`.

`'auto'` mode asks whether every non-empty value parses as a finite number, and a
non-finite number stringified to `"NaN"` — a non-empty value that does not parse. So a
single failed embedding in a `UMAP1` column made the whole column categorical, and
categorical mode then gave every distinct float its own colour.

A non-finite `number` now normalises as missing, the way `null` already did: it does not
influence the mode, and the cell keeps the layer's default colour. The *string* `"NaN"` in
a string column is untouched — there it may be a real category.
