# @spatialdata/react

## 0.6.0

### Patch Changes

- [#142](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/142) [`a0a3cc4`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/a0a3cc456dfaa139d7afbe886acb872bfebad86e) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Publish sourcemaps, and survive a colour scheme that does not match its own type.

  `core` shipped `index.js.map`; `layers`, `vis`, `avivatorish` and `react` did not.
  A crash inside one of them reached a consumer as
  `Le (…/.vite/deps/@spatialdata_layers.js:396)` — an esbuild-minified name with
  nothing to map it back to. An embedding application has only the built artifact to
  debug against, so it has to carry a map.

  `resolveCategoricalPalette` and the ramp sampler now always return a colour. A
  scheme arrives from a saved Render Stack, so its type is a claim about JSON rather
  than a guarantee: a palette object with no `byValue`, a list with a hole in it, or
  a ramp with fewer than two stops all used to return `undefined` and fail several
  frames later in the arithmetic that reads `rgb[0]`. Wrong colours can be seen and
  reported; that `TypeError` cannot.

- Updated dependencies [[`a0a3cc4`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/a0a3cc456dfaa139d7afbe886acb872bfebad86e)]:
  - @spatialdata/core@0.6.0

## 0.5.0

### Patch Changes

- Updated dependencies [[`3215b3b`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/3215b3b5346f7f751a04f51a8a3d9e3623fa2505), [`2c7e3c3`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/2c7e3c31ab3ce4c0fd509ff325bc8c02445fdfb0)]:
  - @spatialdata/core@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [[`baa54e9`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/baa54e9d25524901c6f33804da3b02d54bb89811), [`baa54e9`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/baa54e9d25524901c6f33804da3b02d54bb89811), [`1925695`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/1925695a15e1d354bc8100e55fb6bfca85bfc951), [`0e0f2b5`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/0e0f2b5bd3a905c5cf4559ea80fe7017d195a083), [`886c6f2`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/886c6f2750998aaaf39c7ca617f048ecedade3bb)]:
  - @spatialdata/core@0.4.0

## 0.3.1

### Patch Changes

- Updated dependencies []:
  - @spatialdata/core@0.3.1

## 0.3.0

### Patch Changes

- [#79](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/79) [`8607083`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/86070837958ffb5761d004446b5a23a8520d6c79) Thanks [@xinaesthete](https://github.com/xinaesthete)! - SpatialCanvas hover/picking performance and Rules-of-React cleanup.

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

- Updated dependencies [[`e94ba97`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/e94ba97d472bce02dc2efc4c561e478ed42645de), [`ab1b809`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/ab1b80989b66e27950f74b503c91348b90b60827), [`6e153a6`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/6e153a6e3e7e564d31b835828615d8145b6bc805)]:
  - @spatialdata/core@0.3.0

## 0.2.5

### Patch Changes

- Updated dependencies []:
  - @spatialdata/core@0.2.5

## 0.2.4

### Patch Changes

- Updated dependencies []:
  - @spatialdata/core@0.2.4

## 0.2.3

### Patch Changes

- Updated dependencies []:
  - @spatialdata/core@0.2.3

## 0.2.2

### Patch Changes

- Updated dependencies []:
  - @spatialdata/core@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies []:
  - @spatialdata/core@0.2.1

## 0.2.0

### Patch Changes

- Updated dependencies [[`e20648d`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/e20648df7ba22b869949b684ab70348978eb8774), [`faf55cf`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/faf55cf9988e0a82449f5dcd3b75c01aa6550587)]:
  - @spatialdata/core@0.2.0

## 0.1.0

### Minor Changes

- [#42](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/42) [`0a73939`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/0a73939691b44b44204842e3d408a8d1114c2212) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Prepare the first MDV-targeted alpha prerelease.

### Patch Changes

- Updated dependencies [[`0a73939`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/0a73939691b44b44204842e3d408a8d1114c2212)]:
  - @spatialdata/core@0.1.0

## 0.1.0-next.0

### Minor Changes

- [#42](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/42) [`0a73939`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/0a73939691b44b44204842e3d408a8d1114c2212) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Prepare the first MDV-targeted alpha prerelease.

### Patch Changes

- Updated dependencies [[`0a73939`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/0a73939691b44b44204842e3d408a8d1114c2212)]:
  - @spatialdata/core@0.1.0-next.0
