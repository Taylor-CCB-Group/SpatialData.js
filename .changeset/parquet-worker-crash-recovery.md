---
'@spatialdata/core': minor
---

Restart the parquet worker after a crash instead of switching it off for the page

parquet-wasm answers a refused HTTP range by panicking with `RuntimeError: unreachable`
and leaving its promise unsettled. When that happened inside the worker it surfaced as
an `error` event, and the client decided what it meant by asking *"has this worker
answered a request yet?"* — which is false whenever the panic beats the first response.
A perfectly well-wired worker was therefore read as one that never loaded: disabled,
`startupFailed` latched, and (because `@spatialdata/vis`'s `ensureWorkers` attempts once
per page) unrecoverable without a reload. It even advised passing `workerUrl`, when the
URL was never the problem.

The worker now posts a `ready` message when its module evaluates, and that — not "has it
answered?" — distinguishes the two failures:

| | before | after |
| --- | --- | --- |
| bundle never loads (bad `workerUrl`, CSP) | disabled, latched | unchanged: disabled, latched |
| loads, then crashes | **disabled, latched** | **replaced, feature stays up** |

Answering first does not make a crash survivable — a panic poisons the wasm instance —
so a loaded worker is replaced whether or not it has already replied. Gating recovery on
"has not answered yet" would have missed the common case, since metadata and catalog
requests usually succeed before a refused range panics.

A crash after `ready` rejects the in-flight requests — their transferables died with the
worker, so they cannot be replayed — and starts a replacement with the same options. The
caller's retry then runs against a live worker, which is the difference between a
"Retry" button that can work and one that never could.

Restarts are bounded (3) so a deterministically-crashing store cannot respawn workers
forever, and the budget is replenished on every successful response, so recovery is
per-incident rather than per-page.

Also corrects the error `loadPointsMatchingFeatureCodes` throws: it claimed to require
"the parquet worker and parquet part bytes", while the condition it tests is only
whether the worker is running.

Not fixed here: the same panic on the **main thread** leaves its promise unsettled, so
that path still stalls to the request timeout rather than failing fast.
