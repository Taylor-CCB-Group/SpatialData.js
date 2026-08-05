---
'@spatialdata/core': patch
---

Stop a transient parquet fetch failure from poisoning `loadParquetTable` for the
lifetime of the source.

`parquetTableCache` stores the table promise *before* it settles. That is
deliberate and correct — it is what makes concurrent callers for the same file
share one `readParquet` + `tableFromIPC` decode instead of racing two WASM
parses of the same bytes. What was missing is the other half: nothing ever
removed a promise that settled as a *rejection*. A single failed read — a
dropped connection, a 503, a store not yet warm — left a rejected promise
parked at that path forever, and every subsequent read of that element replayed
a network error that had long since cleared. The only recovery was to construct
a new source.

The cached promise now evicts itself on rejection, and only if it is still the
current entry for that path, so a retry that already superseded it is not
clobbered by the earlier promise's late rejection. This is the same
`evictIfCurrent` discipline `loadParquetDatasetMetadata` and
`discoverMultipartPartPaths` already use.

In-flight dedup and the caching of successful tables are unchanged, and so is
the deliberate skip-vs-fail policy in `docs/plans/parquet-io-error-handling.md`:
the rejection still propagates unchanged to the caller that provoked it. It just
stops being the answer given to the next one.
