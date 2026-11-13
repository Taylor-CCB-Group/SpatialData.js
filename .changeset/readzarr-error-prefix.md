---
'@spatialdata/core': patch
---

`readZarr` rethrows the error from opening a store as is, rather than wrapping it in a new `Error` whose message began "Error: Error:".
