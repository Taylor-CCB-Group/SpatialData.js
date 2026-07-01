# Parquet I/O error handling — follow-up

**Status:** deferred (exceptions kept for now)  
**Last updated:** 2026-06-23  
**Related:** [Error handling](../docs/core/error-handling.mdx), `VTableSource.ts`

Example of limited `Result` adoption — see the error-handling doc for the
general picture. This note is only about parquet I/O.

## Current state

Parquet loading mixes three patterns:

| Pattern | Example | Semantics |
|--------|---------|-----------|
| `null` | `loadParquetFileBytesAtPath` | Missing or invalid bytes (store miss, non-parquet payload) |
| `throw` | `readParquetDatasetBytesCapped`, `loadMultipartParquetTable` | Required bytes unavailable — fail the operation |
| `continue` | `_loadParquetTableUncachedCapped`, `VPointsSource` feature-filter scans | Skip a part and try the rest |

`partPaths` is built from dataset metadata (footer/range reads) or
`discoverMultipartPartPaths` (full-byte probe). Metadata paths are **not**
guaranteed loadable via `loadParquetFileBytesAtPath`; discovered paths were
verified moments earlier in the same call.

## Intentional strictness difference

`readParquetDatasetBytesCapped` **throws** on the first missing part because it
feeds worker decode paths that need reliable byte buffers. Sibling table loaders
use **`continue`** so a later part can still contribute rows. That is a policy
choice, not probing of paths known to be absent.

## Follow-up (when revisiting)

1. Decide whether to expand `Result` at all; if so, evaluate an established
   library (e.g. `neverthrow`) rather than extending the in-house `zarrextra`
   types.
2. Introduce typed errors (e.g. missing part, invalid bytes, empty dataset).
3. Move `loadParquetFileBytesAtPath` to `Result` first; keep a thin `null` shim
   if needed during migration.
4. Migrate protected helpers (`readParquetDatasetBytesCapped`, multipart
   loaders) and unify skip-vs-fail policy per call site.
5. Leave public APIs (`loadParquetTable`, `loadPoints`, …) throwing until vis /
   layers need typed degradation; use `unwrap()` at boundaries meanwhile.

See [Error handling](../docs/core/error-handling.mdx) for the current provisional
`Result` API and adoption patterns (`getTransformation`).
