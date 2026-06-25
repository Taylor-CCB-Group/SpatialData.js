---
"@spatialdata/vis": patch
---

Export `useSpatialCanvasRendererFromLayerInputs`, `ImageLayerContextProvider`, and the `LayerLoadState` type from the package entry point. These symbols were already defined and intended to be public, but were not re-exported — forcing consumers to patch the built bundle or deep-import from `dist`. They are now reachable directly from `@spatialdata/vis`.
