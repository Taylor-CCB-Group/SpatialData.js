---
"@spatialdata/core": patch
"@spatialdata/layers": patch
"@spatialdata/vis": patch
---

Points: make a tiled layer stop reporting — and looking like — a capped preload.

Three things a tiled layer got wrong once it was actually drawing:

- **The resident window is released.** A layer switched to tiling mid-session had
  usually already preloaded, and nothing gave those rows back: `plan()` stops *asking*
  for a preload, which is not the same as evicting one. The probe's settle now drops
  the preload, its row-aligned codes and its feature-index scan (all defined against
  that window); the catalog stays, since it describes the element rather than the
  window.
- **The truncation notice no longer contradicts itself.** It read "4,000,000 of
  12,165,021 points in memory — capped; raise the cap for more" directly above "the
  memory cap does not apply". A tiled layer draws from the viewport, so a resident
  count is not a statement about what is on screen, and the panel now says nothing
  rather than something true and misleading.
- **The tiling status line is live.** It read `engine.isTiled(...)` directly, outside
  the engine subscription, so it kept saying "this element has no Morton index" about
  an element it was already tiling — the probe settles asynchronously and nothing
  re-rendered it. `tiled` now comes through `usePointsFeatureState`, which carries the
  subscription.

Point sizing is also now **one behaviour instead of two**: the Morton tile path sized
points in fixed pixels while the preloaded path used world units, so `pointSize` meant
something different depending on a checkbox, and a zoomed-out tiled layer drew every
one of its millions of points as a fixed screen dot. Density saturated into a flat
mass and every tile seam and acquisition boundary hardened into what looked like a
rendering fault. Both paths now size in world units with the model-matrix scale folded
in, so points shrink as you zoom out and overdraw self-limits.
