---
"@spatialdata/core": minor
"@spatialdata/vis": minor
---

Points: Morton viewport tiling is now on by default (D5 step 7, closes D5).

`pointsTiling` defaults to `'auto'` (`DEFAULT_POINTS_TILING`), so every points element
is probed once and takes the tiled path if — and only if — it can. Read the config
through the new `pointsTilingEnabled(...)` rather than comparing to `'auto'`: the
default has to mean the same thing to the resolver deciding what to load, the hook
deciding what to render, and the panel drawing the checkbox.

**Why on rather than opt-in.** On a Morton artifact the capped preload is not a neutral
alternative: it keeps the first `cap` rows in FILE order, and file order there is a
prefix of the Z-curve — a spatially skewed chunk of the slide rather than a sample of
it. Tiles read what is actually in view, colour by feature, honour the feature filter
inside the row-group scan, and subdivide with zoom.

**What it costs, measured.** At the default zoomed-out framing of a 12.1M-point Xenium
element, the tiled path loads all 44 tiles — 12,165,029 points / ~158 MB, the whole
artifact — against a 4M-row prefix for the preload. So first paint on a fully
zoomed-out view is ~3x the rows, in exchange for a correct picture that streams in 44
pieces instead of blocking on one decode. Zooming OUT is the one direction viewport
tiling does not help, because there is no coarser representation to read; that wants a
multi-resolution points pyramid, not a finer index. `pointsTiling: 'off'` restores the
previous behaviour per layer.

An element that cannot be tiled is unaffected beyond one probe (4 range reads / ~2.16 MB
on a 12.1M-point element, cached with the metadata; on a non-Morton element it is footer
metadata the preload reads anyway). The three guards — no usable sentinel row group, a
sentinel box that is not the code domain, an unsorted Morton column — decline loudly and
fall through to the preload.

The panel now hides the memory-cap control on a tiled layer: it governs nothing there,
and it sat directly above a line saying the cap does not apply.
