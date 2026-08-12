---
'@spatialdata/vis': minor
---

Export the feature-row classification alongside the points feature state.

`usePointsFeatureState` returns raw engine signals — `residentCodes`,
`loadedMatchingCodes`, `matchingLoadState`, `supportsOnDemandLoad` — and
`describeFeatureRowState` is what turns them into a row's rendered state: whether
it is dimmed, a short label, and a sentence explaining why. Only the former was
reachable from the package entry, so an embedder building its own feature list had
the data but not the reading of it, and had to re-derive a precedence order
(resident/rendered beat selection and scan state) that is easy to get subtly wrong
— the failure mode being a panel that greys a feature the canvas is drawing.

Adds `describeFeatureRowState` and `featureRowOpacity`, plus the types
`FeatureRowState`, `FeatureRowStateInput` and `FeatureRowTone`. No behaviour
change; these already backed the built-in `PointsFeatureFilterPanel`.
