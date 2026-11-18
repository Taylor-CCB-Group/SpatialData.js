---
"@spatialdata/layers": patch
---

An image layer moved into or out of an isolated group now draws inside it, with the group's blend mode and opacity. Before, it could draw unblended, or not at all, until something else made it rebuild.
