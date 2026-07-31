---
'@spatialdata/avivatorish': patch
'@spatialdata/layers': patch
'@spatialdata/vis': patch
---

Bump deck.gl to 9.3.7 and the luma.gl ecosystem to 9.3.6.

The catalog entries for the `@deck.gl/*` packages move from `~9.3.5` to `~9.3.7`
and the `@luma.gl/*` entries to `~9.3.6` (the latest 9.3 patch of each).
`@spatialdata/layers` pinned `@luma.gl/engine` outside the catalog at `^9.3.5`;
it now uses `catalog:` like every other deck/luma dependency, so the whole
ecosystem stays on one version.

The lockfile is also deduped: `@luma.gl/shadertools`, `@luma.gl/webgl` and
`@luma.gl/gltf` reach us only as peers of the deck packages, so they had stayed
at 9.3.5 while the directly-declared luma packages moved to 9.3.6. A mixed luma
tree is the kind of thing that breaks deck at runtime rather than at build time,
so they are now collapsed onto 9.3.6 with the rest.
