---
"@spatialdata/core": patch
"@spatialdata/vis": patch
---

Points: apply the feature filter to Morton-tiled layers (D5 step 4).

A tiled layer used to draw every feature in the viewport whatever was selected. The
selection now reaches `getTileData` — and its `updateTriggers`, so changing it
refetches instead of serving the previous selection's cached tiles — and is applied
**inside** the row-group scan, so a tile arrives holding only the selected features.
On a real 12.1M-point transcripts element, selecting one gene takes a viewport tile
from 3,128,988 points to 87,594: 36x fewer points uploaded and drawn.

It does **not** reduce I/O, and the plan's original expectation that it would has been
corrected. The same query read the same 92 row groups and the same 158MB either way:
row groups are chosen *spatially* on a Morton artifact, and a gene's points are spread
across all of them, so no feature filter can skip one. Narrowing the fetch by feature
needs a feature-primary index — the open index-selection question in ADR 0002/0003.

Two supporting fixes:

- **The catalog is planned for a tiled entry.** On the preloaded path it arrives free
  as a preview off the geometry decode; a tiled entry never decodes a resident batch,
  so nothing built one — and a selection is stored as feature NAMES, which cannot
  become the codes the scan filters on without it. A saved config with a selection
  would draw every feature until someone happened to open the filter panel. A failed
  catalog is not re-planned, or the task re-emits on every reconcile forever.
- **Feature rows read honestly on a tiled layer.** Every other signal the panel uses
  describes a resident batch a tiled layer does not have, so its rows fell through to
  "beyond the resident window; select it to fetch its points" — greyed, and wrong
  twice over: the points are available, and no feature-index scan is involved.

`renderCap` stays unset on the tiled path: it is a resident-window notion, and a tile
is already bounded by its viewport.
