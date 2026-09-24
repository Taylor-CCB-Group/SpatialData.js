---
'@spatialdata/core': minor
---

Restart the parquet worker after a crash instead of switching it off for the page

A worker that crashed on a refused HTTP range was indistinguishable from one that never
loaded, so points stayed dead until a page reload. A worker that has loaded is now
replaced when it crashes, bounded to 3 restarts, and its in-flight requests reject so a
caller's retry runs against a live worker. The same panic on the **main thread** still
stalls to the request timeout.
