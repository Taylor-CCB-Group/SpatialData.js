---
'zarrextra': patch
---

Remove the unused `zarrSchema` module and drop the now-unneeded `zod` dependency.

The zod schemas for v2 `.zarray` and v3 `zarr.json` array metadata had no callers and were never exported. Validating tree metadata on open is a road this package has now deliberately not taken: `ZarrArrayMetadata` admits an unrecognised record precisely so a store carrying a data type we do not model still opens, and `getArrayDtype` answers `undefined` for such a type rather than throwing. A schema that rejects the whole store at open time is the opposite of that, and `zarrita` already validates array metadata on the real read path.

The one genuinely useful thing the module did — reconciling v2's `dtype` with v3's `data_type` — is now `normalizeDtype`, which does it in `zarrita`'s own `DataType` vocabulary instead of leaving a numpy typestring in a v3-shaped field.
