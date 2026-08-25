---
"@spatialdata/core": minor
---

**Breaking:** the points worker is now the parquet worker.

It decodes and scans parquet for shapes as well as points — Morton row groups,
feature catalogs, WKB geometry — so the old name described one caller rather than
the worker. Every name moves with it, with no aliases:

| Before                             | After                                 |
| ---------------------------------- | ------------------------------------- |
| `@spatialdata/core/points-worker`  | `@spatialdata/core/parquet-worker`    |
| `enablePointsWorker`               | `enableParquetWorker`                 |
| `disablePointsWorker`              | `disableParquetWorker`                |
| `ensurePointsWorker`               | `ensureParquetWorker`                 |
| `isPointsWorkerEnabled`            | `isParquetWorkerEnabled`              |
| `setPointsWorkerDefaultEnabled`    | `setParquetWorkerDefaultEnabled`      |
| `setPointsWorkerRequestTimeout`    | `setParquetWorkerRequestTimeout`      |
| `PointsWorkerRequest` / `Response` / `Message` | `ParquetWorkerRequest` / `Response` / `Message` |

A worker that never loads is now detected and switched off instead of being left
to time out. The `error` event from a worker that has not yet answered anything is
treated as "never wired up": pending requests reject with a message naming
`workerUrl`, `isParquetWorkerEnabled()` starts reporting `false` so callers take
their main-thread fallbacks, and `ensureParquetWorker()` stops rebuilding it. A
misconfigured worker now costs performance rather than a 30-second stall per
request — except for `loadPointsMatchingFeatureCodes`, which has no fallback and
throws immediately with a reason instead of hanging.

New: `docs/docs/core/bundling.mdx` ("Bundling core into an application")
documents the one thing a consumer must configure,
and `tests/production/browser/parquet-worker.spec.ts` holds it — the published
worker entry is started from a real production build and decodes a fixture, which
covers its module format, its `exports` subpath, and the parquet-wasm it resolves
inside its own bundle.
