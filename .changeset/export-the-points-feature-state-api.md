---
'@spatialdata/vis': minor
---

Export the points feature-state API from the package entry.

`PointsFeatureStateProvider`, `usePointsFeatureState` and the points engine types
were exported from `SpatialCanvas/public.ts` — and the comment there tells you to
pull `pointsEngine` off the renderer hook and wrap a subtree in the provider — but
`src/index.ts` never re-exported them. Since the package publishes only a `"."`
export, there was no deep-import route either, so the documented integration path
was unreachable to anyone outside this repo: the demo panels work because they
import by relative path.

Adds `PointsFeatureStateProvider` and `usePointsFeatureState`, plus the types
`PointsDataEngine`, `PointsLoadTarget`, `PointsFeatureState`,
`PointsFeatureSelection` and `PointsFeatureStateProviderProps`. No behaviour
change; this is the surface an embedding application needs to build its own points
feature UI rather than reimplementing the engine subscription.
