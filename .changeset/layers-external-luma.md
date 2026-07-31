---
'@spatialdata/layers': patch
---

Stop bundling luma.gl into the published `@spatialdata/layers` artifact.

The build externalized only the specifiers this package imports directly, so
`@luma.gl/core`, `/engine` and `/shadertools` (plus `@probe.gl/*`) were pulled in
transitively and shipped inside `dist/index.js` — 238 kB down to 92 kB now that they
are not.

Size was the least of it. deck.gl, Viv and this package must share ONE luma runtime.
A consumer that also loads deck.gl got two `ShaderAssembler` classes, and
`ShaderAssembler.getDefaultShaderAssembler()` is a static — so "the default shader
assembler" meant different objects to deck and to Viv. Viv's `VivShaderAssembler`
builds itself by copying that default's modules and hook functions, so it could copy
from an assembler deck had never registered anything on, and every Viv-derived layer —
labels included — then failed to compile its vertex shader for want of deck's
`DECKGL_FILTER_*` hooks.

The externals are now whole families by regex rather than a list of today's imports,
matching what `@spatialdata/vis` has always done.
