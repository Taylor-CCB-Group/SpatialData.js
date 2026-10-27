---
"@spatialdata/core": patch
---

A shapes layer whose tooltip fields or fill-colour column fail to load no longer re-requests them on every render; the failure stays until the config changes.
