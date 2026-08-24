---
'zarrextra': minor
---

Make a cancelled chunk read actually cancel.

`getZarrChunk` accepted an `AbortSignal` and wrapped the read in `rejectOnAbort`,
which raced the signal against the promise and rejected early. That stopped the
caller *awaiting* the read and nothing more: the store request and the worker
decode ran to completion, unobserved. A pan that outran its tiles paid the full
network and decode cost of every tile it had already abandoned, and the only
visible sign was that the numbers never quite added up.

The signal is now handed to whichever backend is serving the read, both of which
take it as a first-class option:

- **fizarrita** (worker decode) aborts the store requests it makes — metadata,
  chunk-shape probe, and chunk fetches alike — and drops chunk tasks still queued
  on the worker pool rather than starting them.
- **zarrita** (main thread) forwards it to every `store.get` and re-checks it
  between chunks, so a multi-chunk read stops early instead of running the rest
  out.

Neither interrupts a decode already running on a worker; that result is decoded
and discarded. So this bounds what a cancelled read *starts*, not what it has
already handed over — worth knowing before treating cancellation as free.

`rejectOnAbort` is deleted rather than kept alongside: fizarrita rejects promptly
with the signal's reason on its own, and two things racing to reject one read is
a good way to end up unable to say which reason a caller will see.

The signal is also now structurally excluded from the backend-level options set
once by `enableWorkerChunkDecode`. Cancellation belongs to a single read, and a
signal parked on the backend would quietly govern every read it ever served.
