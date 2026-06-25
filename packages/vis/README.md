# @spatialdata/vis

High-level React-components and deck.gl layers for visualising SpatialData. This package is explicitly less stable and more experimental than the related `core` and `react` packages - the dependency on the `viv`/`deck.gl`/`luma.gl` stack means that installing it into an app (particularly one that already uses anything from this ecosystem) entails a certain amount of care around potential conflicts or breaking changes between versions.

It is hoped that it will be robust and of a high quality, but especially at the early stage of development, the goal is not to have a lean bundle size, guarantees of API stability between releases, etc.

It is used to provide working examples for displaying in the `docs` site, as well as a sample app primarily for prototyping while developing features.

## Browser codec workers

`SpatialCanvas` enables the bundled `zarrextra` codec worker automatically in
browser contexts. Apps using normal vis components can load JP2K
(`imagecodecs_jpeg2k`) and OpenJPH HTJ2K (`experimental.openjph_htj2k`) backed
Zarr images without passing a `workerUrl` or calling `zarrextra/workers`
directly.

`ensureCodecWorkers()` is exported for hosts that want to activate this path
before mounting UI. The helper is idempotent, so repeated calls do not replace
the worker pool.

## Local fixture demos

```bash
pnpm test:fixtures:generate:0.7.2
pnpm test:fixtures:generate:codecs
pnpm --filter @spatialdata/vis dev
```

- http://127.0.0.1:5173/headless loads the versioned `blobs.zarr` fixture.
- http://127.0.0.1:5173/codec loads local codec fixtures (JP2K smoke test, HTJ2K Mandelbulb volume, HTJ2K encode demo).
