---
"@spatialdata/vis": minor
"@spatialdata/layers": patch
"@spatialdata/react": patch
---

SpatialCanvas hover/picking performance and Rules-of-React cleanup.

Picking/tooltip performance:

- New `hoverTooltipMode` prop (`'off' | 'simple' | 'aggregate'`, default
  `'aggregate'`) on `SpatialCanvas` and `SpatialCanvasViewer`, with a matching
  selector in the `SpatialCanvas` UI. `'aggregate'` reports every feature under
  the cursor across layers (`pickMultipleObjects` GPU passes); `'simple'`
  resolves the single top-most pick deck.gl already does for hover/highlight;
  `'off'` makes shape layers non-pickable entirely (no autoHighlight, no
  picking-buffer render) — the cheapest mode. Replaces the earlier boolean
  `aggregateHoverTooltips`.
- Picking stays live through pan/zoom. The shapes layer keeps a `pickingEnabled`
  option (`@spatialdata/layers`) that `'off'` mode uses to drop picking, but it
  is no longer toggled by camera gestures — the `FlatPolygonLayer` pick pass is a
  single cheap vertex-pulled draw, so no gesture gate is needed.
- Hover tooltip resolution is suppressed while a pointer button is held (drag),
  and the per-missing-layer supplemental aggregation pick is collapsed into a
  single batched pick. The hover-tooltip machinery (pick → tooltip → portal) is a
  single `useHoverFeatureTooltip` hook shared by both canvas surfaces.

Rules-of-React fixes (eslint-plugin-react-hooks, `pnpm lint:react` now clean and
the `react-lint` CI job is required): removed ref reads/writes during render and
replaced setState-in-effect patterns with derived state in `@spatialdata/react`
`useSpatialData` and the vis `Transforms`, `Table`, `Shapes`, `ImageView`, and
`SpatialCanvas` components.
