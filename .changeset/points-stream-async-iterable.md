---
'@spatialdata/core': minor
---

Add `streamPoints()`, the async-iterable form of the incremental points load

`onProgress(partialResult)` left three properties implicit that an iterable states
outright (#175): partial failure is *consumed n items, then it threw*, cancellation is
`break`, and read-ahead depth is visible rather than unexpressed.

```ts
for await (const progress of element.streamPoints({ includeFeatureCodes: true })) {
  draw(progress.partialResult);
}
```

Additive:

- `SpatialDataPointsSource.streamPoints` / `PointsElement.streamPoints` — an
  `AsyncGenerator<PointsLoadProgress, PointsLoadResult>`. It yields the growing result
  and *returns* the settled one, which `for await` discards.
- `streamPointsMatchingFeatureCodes` beside `loadPointsMatchingFeatureCodes`.
- `coalesceLatest`, `sampleByStep` and `drainStream` — generic combinators over async
  iterables. `coalesceLatest` is the rate lever: it drops superseded items when the
  consumer falls behind, sound here only because every points tick is cumulative.

`PointsLoadOptions.onProgress` is deprecated but fully supported and implemented by
draining the same generator, so the two cannot drift. It still selects the progressive
read path, so a caller passing no callback takes the one-shot decode exactly as before.
Nothing is scheduled for removal.

Internally `streamGeometryWithFeaturesInWorker` is a generator and `postRequest`'s
`onChunk` option is gone; streaming requests go through `postStreamingRequest`, which
owns the queue. Neither is published, so no consumer sees the change.

Not done here: `PointsResolver` keeps its `silent`-emit throttle. It has to keep the
partial fresh on every tick while notifying rarely, which is neither combinator's
policy, so replacing it deserves its own evidence.
