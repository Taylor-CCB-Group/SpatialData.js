---
"@spatialdata/avivatorish": patch
---

Export `useChannelSelectionStats` hook from `@spatialdata/avivatorish`. Stateful async stats hook that fetches, caches, and returns per-channel stats (domain, contrastLimits, raster) keyed by channelId — plus a positional `statsByIndex` convenience array and per-channel loading flags. Ports the async cache/load/cancel loop from MDV's `useImageLayerRuntime` so consumers no longer reimplement it locally.
