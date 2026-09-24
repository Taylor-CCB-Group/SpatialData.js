---
'@spatialdata/core': patch
---

Bound main-thread parquet stream reads, so a stalled reader fails over instead of hanging

parquet-wasm answers a refused HTTP range by panicking with `RuntimeError: unreachable`
and **leaving its promise unsettled**. In the parquet worker that surfaces as an `error`
event, and `armTimeout` has always bounded the wait. Driven on the main thread —
`ParquetFile.stream()`, used by the points preload, the feature scan and the in-bounds
stream — there is no error event and there was no watchdog, so `await reader.read()`
never returned: the caller hung, no fallback was taken, and nothing was logged. That is
the "it timed out loading a feature" stall, and the timeout was whatever sat far above.

Each of those three reads now shares the worker's silence budget
(`setParquetWorkerRequestTimeout`, 30s by default, `0`/`Infinity` to disable). On
expiry the stream is cancelled so it stops fetching, and the read rejects with which
stage stalled — a rejection every one of these callers already handles by falling back
to the byte-oriented reader, the path that serves stores the streaming one cannot.

The same budget also bounds the steps that OPEN a stream (`ParquetFile.fromUrl()` and
`file.stream()`), since the panic can land there too, before there is a reader to guard.
`Promise.race` does not cancel its loser, so a late-arriving open is released rather than
left running: a `ParquetFile` is freed, a `ReadableStream` cancelled. Otherwise every
timeout would leak range work alongside the fallback it just triggered.

`checkAbort` could not cover this: it runs between settled reads, and the read that
matters never settles.
