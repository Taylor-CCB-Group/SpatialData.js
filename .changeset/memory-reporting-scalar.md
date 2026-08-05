---
'@spatialdata/core': minor
---

Add `MemoryReporting` — `{ readonly byteLength: number }` — the first rung of
[ADR 0005](https://github.com/Taylor-CCB-Group/SpatialData.js/blob/main/docs/adr/0005-memory-accounting-before-management.md).

The library had a memory *policy* and no memory *accounting*: `DEFAULT_POINTS_MEMORY_CAP`
is a row count applied to one element kind, and nothing anywhere could answer
"how many bytes are resident right now?". This is that answer, and only that
answer — no tiers, no eviction, no ceiling.

The name is doing the work. `byteLength` is what `TypedArray`, `ArrayBuffer` and
`DataView` already call this, so every payload we actually hold satisfies the
interface structurally, with no wrapper and no import. That is what makes it
cheap enough to put on every cache rather than on a chosen few.

Implementors take on one obligation: keep the number cheap to read — a running
total maintained on insert and evict, not a scan of the residents per read — so
that callers can poll it freely.
