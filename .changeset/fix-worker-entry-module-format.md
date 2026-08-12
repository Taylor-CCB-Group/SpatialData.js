---
'@spatialdata/core': patch
---

Emit the `workers` and `points-worker` entries as ES modules.

The lib `fileName` named only `index` per format; every other entry got
`${entryName}.js` from BOTH the es and cjs passes, so the cjs output silently
overwrote the es one. `dist/workers.js` and `dist/points-worker.js` therefore
shipped as CommonJS under a `.js` extension inside a `"type": "module"` package —
files nothing can load.

`enablePointsWorker` constructs the worker with `new Worker(url, { type: 'module' })`,
so loading the published `points-worker.js` failed with `ReferenceError: require is
not defined` and the worker never answered. That made the points worker impossible
to start outside this repo, and with it the feature-index scan: a points selection
whose rows fall beyond the memory cap could not be fetched at all, because
`loadPointsMatchingFeatureCodes` throws rather than falling back to the main thread.
The demo did not catch it because it imports the worker's TypeScript source by
relative path.

Every entry now names its format, and `./workers` gains explicit `import`/`require`
conditions. A packaging test asserts each `exports` target really is in the module
system its extension and the package `type` imply.
