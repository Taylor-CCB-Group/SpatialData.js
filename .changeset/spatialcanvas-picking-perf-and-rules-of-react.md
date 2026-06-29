---
"@spatialdata/vis": minor
"@spatialdata/layers": patch
"@spatialdata/react": patch
---

SpatialCanvas hover/picking performance and Rules-of-React cleanup.

Picking/tooltip performance:

- `aggregateHoverTooltips` now defaults to `false`. Aggregation issued extra
  `pickMultipleObjects` GPU passes on every pointer move (on top of the pick
  deck.gl already does for hover/highlight), which is very expensive over large
  pickable geometry. Single-pick hover uses the existing pick; enable
  aggregation explicitly when stacked-layer tooltips are needed.
- Shape layers are made non-pickable (and `autoHighlight` disabled) while the
  camera is being panned/zoomed, so deck.gl does not re-render the shape
  geometry into the picking buffer during gestures. New `pickingEnabled` option
  on the shapes layer (`@spatialdata/layers`) drives this.
- Hover tooltip resolution is throttled to one run per animation frame, skips
  redundant same-pixel work, is suppressed while a pointer button is held
  (drag), and collapses the per-missing-layer supplemental pick storm into a
  single batched pick.

Rules-of-React fixes (eslint-plugin-react-hooks, `pnpm lint:react` now clean and
the `react-lint` CI job is required): removed ref reads/writes during render and
replaced setState-in-effect patterns with derived state in `@spatialdata/react`
`useSpatialData` and the vis `Transforms`, `Table`, `Shapes`, `ImageView`, and
`SpatialCanvas` components.
