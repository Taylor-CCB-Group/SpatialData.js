---
"@spatialdata/core": minor
"@spatialdata/react": minor
---

`SpatialData.badFiles` lists the elements that were in the store but failed to load (`{ path, error }`, in the order found), so any consumer can report them after the fact. `SpatialDataProvider` accepts `onBadFiles`; changing its identity does not reopen the store.
