---
'zarrextra': patch
---

Remove the unused `zarrSchema` module and drop `zod` from the package's dependencies.

The v2 `.zarray` / v3 `zarr.json` schemas were never exported, so no public API changes. Array metadata stays unvalidated on the tree by design: `zarrita` validates on the real read path, and `getArrayDtype` already reconciles both generations' dtype spellings.
