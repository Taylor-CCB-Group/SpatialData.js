# @spatialdata/avivatorish

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
