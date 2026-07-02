---
"@spatialdata/vis": minor
"@spatialdata/layers": patch
"@spatialdata/react": patch
---

SpatialCanvas hover/picking performance and Rules-of-React cleanup.

Picking/tooltip performance:

- New `hoverTooltipMode` prop (`'off' | 'simple' | 'aggregate'`, default
  `'simple'`) on `SpatialCanvas` and `SpatialCanvasViewer`, with a matching
  selector in the `SpatialCanvas` UI. `'simple'` resolves the tooltip from the
  single top-most pick deck.gl already does for hover/highlight; `'aggregate'`
  adds `pickMultipleObjects` GPU passes to include every layer under the cursor
  (more expensive); `'off'` makes shape layers non-pickable entirely (no
  autoHighlight, no picking-buffer render) — the cheapest mode. Replaces the
  earlier boolean `aggregateHoverTooltips`.
- Shape layers are made non-pickable (and `autoHighlight` disabled) while the
  camera is being panned/zoomed, so deck.gl does not re-render the shape
  geometry into the picking buffer during gestures. New `pickingEnabled` option
  on the shapes layer (`@spatialdata/layers`) drives this.
- Hover tooltip resolution is suppressed while a pointer button is held (drag),
  and the per-missing-layer supplemental aggregation pick is collapsed into a
  single batched pick.

Rules-of-React fixes (eslint-plugin-react-hooks, `pnpm lint:react` now clean and
the `react-lint` CI job is required): removed ref reads/writes during render and
replaced setState-in-effect patterns with derived state in `@spatialdata/react`
`useSpatialData` and the vis `Transforms`, `Table`, `Shapes`, `ImageView`, and
`SpatialCanvas` components.
