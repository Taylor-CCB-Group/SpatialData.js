---
"@spatialdata/core": patch
---

Fall back to the main thread when the parquet worker rejects a shapes decode.

`loadFlatShapeGeometry` handled the worker returning `null` — never enabled — but
let a rejection propagate, so a request timeout, a worker that died mid-request, or
one that failed to start between the enabled check and the post failed the whole
element instead of decoding it on the main thread. Every other worker call site
already caught. The catch is scoped to the worker call, so a genuine store read
failure still surfaces as one.
