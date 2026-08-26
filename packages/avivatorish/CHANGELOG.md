# @spatialdata/avivatorish

## 0.9.0

### Patch Changes

- Updated dependencies [[`824576c`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/824576c2012e41ba0d628863f7acb0b671948a55), [`824576c`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/824576c2012e41ba0d628863f7acb0b671948a55)]:
  - zarrextra@0.5.0

## 0.8.0

## 0.7.0

## 0.6.0

### Patch Changes

- [#120](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/120) [`f0f8df1`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/f0f8df1a1acebffc450fd254c72bf46b5596ef4c) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Drop the direct `geotiff` dependency from both packages.

  `@spatialdata/vis` declared it but never imported it. `@spatialdata/avivatorish`
  imported `fromUrl` / `fromBlob` in exactly one place, feeding a chain of
  non-exported Avivator scaffolding for plain multi-TIFF inputs that nothing
  reached — `createLoader` is OME-NGFF-only by design. Both are now gone, along
  with the matching Vite `external` entries.

  No public API changes, and nothing to lose on the OME-TIFF side: there was no
  OME-TIFF loading path to break. The only loaders here are `loadOmeZarr` and
  `loadOmeZarrMultiscalesData`, and the exported `OME_TIFF` type is a type-only
  derivation from viv's `loadOmeTiff` signature — `import type`, so it costs
  nothing at runtime and needs no `geotiff` of our own.

  Declaring the dependency only ever added a third copy to consumers' trees, and
  pinned us to a version we could neither exercise nor usefully advance: were an
  OME-TIFF path ever added, it would go through viv, which resolves its own
  `geotiff` (`^2.0.5`) regardless, and geotiff 3's decoder API is a viv-side
  blocker (hms-dbmi/viv#951), not ours.

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

## 0.5.0

### Patch Changes

- Updated dependencies [[`423448b`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/423448b13e6a2cb07324faa9b318dca2c6ba1c59), [`2c7e3c3`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/2c7e3c31ab3ce4c0fd509ff325bc8c02445fdfb0)]:
  - zarrextra@0.4.0

## 0.4.0

### Patch Changes

- [#98](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/98) [`ed2979d`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/ed2979de3ecf1eca95d2d78cabf79622b13c9c32) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Bump deck.gl to 9.3.7 and the luma.gl ecosystem to 9.3.6.

  The catalog entries for the `@deck.gl/*` packages move from `~9.3.5` to `~9.3.7`
  and the `@luma.gl/*` entries to `~9.3.6` (the latest 9.3 patch of each).
  `@spatialdata/layers` pinned `@luma.gl/engine` outside the catalog at `^9.3.5`;
  it now uses `catalog:` like every other deck/luma dependency, so the whole
  ecosystem stays on one version.

  The lockfile is also deduped: `@luma.gl/shadertools`, `@luma.gl/webgl` and
  `@luma.gl/gltf` reach us only as peers of the deck packages, so they had stayed
  at 9.3.5 while the directly-declared luma packages moved to 9.3.6. A mixed luma
  tree is the kind of thing that breaks deck at runtime rather than at build time,
  so they are now collapsed onto 9.3.6 with the rest.

## 0.3.1

## 0.3.0

### Patch Changes

- Updated dependencies [[`e343a72`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/e343a721ce949fd9592c8ead2edec9a238f70f92)]:
  - zarrextra@0.3.0

## 0.2.5

### Patch Changes

- Updated dependencies [[`c5e6deb`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/c5e6deb3c5f621844302c80ae92603b3f70cacf3)]:
  - zarrextra@0.2.3

## 0.2.4

### Patch Changes

- [#60](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/60) [`a582811`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/a582811d69944f0958256b05d4de1a2a240d09b3) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Export `channelConfigsEqual` and `serializeChannelConfig` for an order-stable channel-config identity. `serializeChannelConfig` produces a canonical string that is independent of object-key insertion order — the `selections` rows are normalized to a fixed `[z, c, t]` order — giving consumers a single shared basis for channel-config equality and identity keys instead of a fragile `JSON.stringify`.

- [#62](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/62) [`93baa69`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/93baa695cd9ac5ad42384fba46bd888fd58eb698) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Export `selectionStatsKey` and `pickDefaultSelectionForAdd` from `@spatialdata/avivatorish`. These are the pure, app-agnostic channel-stats/selection helpers a consumer's runtime stats bridge needs (stats-cache identity keyed by channelId + z/c/t selection, and first-unused-channel default when adding a row), so consumers no longer redefine them locally.

- [#62](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/62) [`93baa69`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/93baa695cd9ac5ad42384fba46bd888fd58eb698) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Export `useChannelSelectionStats` hook from `@spatialdata/avivatorish`. Stateful async stats hook that fetches, caches, and returns per-channel stats (domain, contrastLimits, raster) keyed by channelId — plus a positional `statsByIndex` convenience array and per-channel loading flags. Ports the async cache/load/cancel loop from MDV's `useImageLayerRuntime` so consumers no longer reimplement it locally.

## 0.2.3

### Patch Changes

- [#57](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/57) [`05145f8`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/05145f84207fae838733eb07077c4e58d1378d98) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Add MDV integration APIs: `useLayerChannelState` and raster selection stats in `@spatialdata/avivatorish`; Viv extension passthrough (`vivLayerProps`, `vivImageExtensionResolver`, `vivImagePropsResolver`, `ImageLayerContext`) in `@spatialdata/vis`. `ImageChannelPanel` remains internal to `SpatialCanvas` and is not part of the published API.

## 0.2.2

### Patch Changes

- Updated dependencies [[`c84758c`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/c84758c780db65737a7978231586ea7d99e1d4fb)]:
  - zarrextra@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies [[`4e58f28`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/4e58f28f585ab4e95f0057cba1b27ce75045402a)]:
  - zarrextra@0.2.1

## 0.2.0

### Minor Changes

- [#48](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/48) [`e20648d`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/e20648df7ba22b869949b684ab70348978eb8774) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Add support for alternative codecs in zarrextra, with tooling to encode images as JPEG2000 and HTJ2K.

  Zarrita stores can be configured to decode in workers.

### Patch Changes

- Updated dependencies [[`e20648d`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/e20648df7ba22b869949b684ab70348978eb8774)]:
  - zarrextra@1.0.0

## 0.1.0

### Minor Changes

- [#42](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/42) [`0a73939`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/0a73939691b44b44204842e3d408a8d1114c2212) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Prepare the first MDV-targeted alpha prerelease.

## 0.1.0-next.0

### Minor Changes

- [#42](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/42) [`0a73939`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/0a73939691b44b44204842e3d408a8d1114c2212) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Prepare the first MDV-targeted alpha prerelease.
