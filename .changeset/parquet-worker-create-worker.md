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
// myWorkerEntry.ts — one line, in your own source
import '@spatialdata/core/parquet-worker';
```

```ts
ensureWorkers({
  parquet: {
    createWorker: () =>
      new Worker(new URL('./myWorkerEntry.ts', import.meta.url), { type: 'module' }),
  },
});
```

The local entry file is load-bearing: pointing the URL at the bare
`@spatialdata/core/parquet-worker` specifier makes webpack emit this package's published
worker entry as an unbundled static asset, 9kB whose every import 404s.

Constructing the worker is also now failure-tolerant. A `createWorker` factory is host
code and can throw, and `new Worker` itself throws on a URL the browser rejects or under
a CSP that forbids it; either used to propagate out of `enableParquetWorker` and take the
caller's render with it. Both are now caught, warned about, and left switched off, which
is how every other worker failure here already behaves.

A factory rather than a `Worker`, because enabling tears down and rebuilds — an
instance could only be used once. Takes precedence over `workerUrl`; Vite hosts keep
using the `?worker&url` import and are unaffected.
