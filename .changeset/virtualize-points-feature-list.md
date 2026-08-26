---
'@spatialdata/vis': minor
'@spatialdata/core': patch
---

Virtualize the points feature list

The list rendered a row per catalog entry. On a 12,448-feature Xenium element that is
91,107 DOM nodes and 12,453 checkboxes for a list showing eight rows at a time (#172);
measured after, 745 nodes and 17 rows.

Windowed with `@tanstack/react-virtual` (a new `@spatialdata/vis` dependency) at a fixed
22px row height — the rows are single lines, so nothing needs measuring. Scroll extent,
search, sorting, colour overrides and hover highlighting are unchanged.

That promoted the classification pass to the floor, so it goes too: the summary lines
count greyed and partly-loaded rows across the whole catalog however few rows render,
and they ran on every engine notify. They are now memoised, and only mounted rows are
classified per render.

One supporting change in `@spatialdata/core`: `PointsResolver`'s covered-codes set is
memoised on the scan signature. It was re-parsing a 12k-entry string and returning a
fresh `Set` per call, which defeated any memoisation downstream of it.
