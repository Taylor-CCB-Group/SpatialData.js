---
"@spatialdata/core": minor
---

**Breaking:** the points worker is now the parquet worker. It decodes and scans
parquet for shapes as much as for points, so the old name described one caller. No
aliases:

| Before                          | After                              |
| ------------------------------- | ---------------------------------- |
| `@spatialdata/core/points-worker` | `@spatialdata/core/parquet-worker` |
| `enablePointsWorker`            | `enableParquetWorker`              |
| `disablePointsWorker`           | `disableParquetWorker`             |
| `ensurePointsWorker`            | `ensureParquetWorker`              |
| `isPointsWorkerEnabled`         | `isParquetWorkerEnabled`           |
| `setPointsWorkerDefaultEnabled` | `setParquetWorkerDefaultEnabled`   |
| `setPointsWorkerRequestTimeout` | `setParquetWorkerRequestTimeout`   |
| `PointsWorkerRequest` / `Response` / `Message` | `ParquetWorkerRequest` / `Response` / `Message` |

A worker that never loads is now detected instead of left to time out: an `error`
from a worker that has not yet answered means it was never wired up, so it is
switched off, `isParquetWorkerEnabled()` reports `false`, and callers take their
main-thread fallbacks. A bad `workerUrl` now costs performance rather than a stall
per request — except for `loadPointsMatchingFeatureCodes`, which has no fallback and
throws immediately with a reason.

New docs page, "Bundling into an application", covers the one thing a consumer must
configure.
