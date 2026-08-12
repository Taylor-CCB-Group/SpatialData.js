---
'@spatialdata/layers': patch
'@spatialdata/vis': patch
'@spatialdata/avivatorish': patch
'@spatialdata/react': patch
---

Publish sourcemaps, and survive a colour scheme that does not match its own type.

`core` shipped `index.js.map`; `layers`, `vis`, `avivatorish` and `react` did not.
A crash inside one of them reached a consumer as
`Le (…/.vite/deps/@spatialdata_layers.js:396)` — an esbuild-minified name with
nothing to map it back to. An embedding application has only the built artifact to
debug against, so it has to carry a map.

`resolveCategoricalPalette` and the ramp sampler now always return a colour. A
scheme arrives from a saved Render Stack, so its type is a claim about JSON rather
than a guarantee: a palette object with no `byValue`, a list with a hole in it, or
a ramp with fewer than two stops all used to return `undefined` and fail several
frames later in the arithmetic that reads `rgb[0]`. Wrong colours can be seen and
reported; that `TypeError` cannot.
