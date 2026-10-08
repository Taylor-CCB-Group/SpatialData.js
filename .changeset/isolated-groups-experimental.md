---
"@spatialdata/layers": minor
"@spatialdata/vis": patch
---

Experimental `IsolatedGroupLayer`: draws its member layers into an offscreen target and composites them with the group's opacity and blend mode, on WebGL and WebGPU. Views sharing a view state share one target, redrawn only when its members change. deck reports picks inside a group against the group; `getIsolatedGroupMember(info)` returns the member, and the SpatialCanvas viewers resolve tooltips and feature events through it.
