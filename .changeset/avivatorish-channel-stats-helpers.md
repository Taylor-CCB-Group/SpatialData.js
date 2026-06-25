---
"@spatialdata/avivatorish": patch
---

Export `selectionStatsKey` and `pickDefaultSelectionForAdd` from `@spatialdata/avivatorish`. These are the pure, app-agnostic channel-stats/selection helpers a consumer's runtime stats bridge needs (stats-cache identity keyed by channelId + z/c/t selection, and first-unused-channel default when adding a row), so consumers no longer redefine them locally.
