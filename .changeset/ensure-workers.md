---
"@spatialdata/vis": minor
---

`ensureWorkers()` starts the codec and parquet workers in one call.

```ts
import { ensureWorkers } from '@spatialdata/vis';
import workerUrl from '@spatialdata/core/parquet-worker?worker&url';

ensureWorkers({ parquet: { workerUrl } });
```

The two workers are wired up differently — the codec worker needs no
configuration, the parquet worker needs a URL your bundler produces — and this is
the seam that hides the difference. Options are per-worker and all optional, so
`ensureWorkers()` is a valid call and there is room for more overrides later;
`false` for either leaves it off. It returns `{ codec, parquet }`: what is actually
running, which outside a browser or after a failed worker load is not what was
asked for. `ensureCodecWorkers()` remains for hosts that only want that one.

Starting the parquet worker is attempted once per page: `enableParquetWorker`
rebuilds on every call and clears core's dead-worker latch as it does, so an
`ensure` that forwarded every call would retry a doomed worker on every render.
