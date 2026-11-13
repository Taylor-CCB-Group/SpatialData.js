---
"@spatialdata/core": minor
"@spatialdata/layers": minor
"@spatialdata/vis": minor
---

The Render Stack is now a tree (`schemaVersion: 2`): a `group` entry holds its children as entries, with typed `opacity`, `blendMode` and `isolate` props, and ids are unique across the tree. `renderStackSchema` upgrades a saved v1 stack, and `migrateRenderStack(stack)` does the same as a plain function, returning notices for any child ids it dropped. Code that reads `stack.entries` directly sees only the top level; use `walkRenderStackEntries` or `findRenderStackEntry` to reach entries inside groups.

`renderStackToDeckLayers(stack, { entryLayers, hostLayerResolver })` turns a stack into deck layers, wrapping each isolated group, or group with a blend mode other than `pass-through`, in an `IsolatedGroupLayer`. It needs no SpatialData or Viv, and `SpatialViewer` uses it when given `renderStack`. Feature pick events carry the resolved `entryId`, and `resolvePickedEntryId(info)` does the same for hosts reading deck picks themselves.

`IsolatedGroupLayer` draws members under ids scoped to the group (`<group>/<member>`). Use `getIsolatedGroupMemberId(info)` for the member's own id; `getIsolatedGroupMember(info).id` is now the scoped one.
