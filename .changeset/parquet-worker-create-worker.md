---
"@spatialdata/core": minor
"@spatialdata/vis": minor
---

`enableParquetWorker` and `ensureWorkers` accept a `createWorker` factory, for
bundlers that cannot hand back a URL for a *bundled* worker.

webpack is the case this exists for. It only builds a worker when it can see the
`new Worker(new URL(...))` form literally, so there is no URL to import ahead of
time; `workerUrl` has no answer for it, and the "Other bundlers" row of the bundling
page was advice nobody could follow.

```ts
ensureWorkers({
  parquet: {
    createWorker: () =>
      new Worker(new URL('./myWorkerEntry.ts', import.meta.url), { type: 'module' }),
  },
});
```

A factory rather than a `Worker`, because enabling tears down and rebuilds — an
instance could only be used once. Takes precedence over `workerUrl`; Vite hosts keep
using the `?worker&url` import and are unaffected.
