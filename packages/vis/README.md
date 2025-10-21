# @spatialdata/vis

High-level React-components and deck.gl layers for visualising SpatialData. This package is explicitly less stable and more experimental than the related `core` and `react` packages - the dependency on the `viv`/`deck.gl`/`luma.gl` stack means that installing it into an app (particularly one that already uses anything from this ecosystem) entails a certain amount of care around potential conflicts or breaking changes between versions.

It is hoped that it will be robust and of a high quality, but especially at the early stage of development, the goal is not to have a lean bundle size, guarantees of API stability between releases, etc.

It is used to provide working examples for displaying in the `docs` site, as well as a sample app primarily for prototyping while developing features.