# WebGPU and Viv: what could move upstream

**Status:** open question, for discussion with Viv maintainers. Our WebGPU image and
labels path lives in `packages/layers/src/webgpu/` and overrides Viv through
`renderSubLayers`; nothing here blocks it.

Viv expands channel code per channel count (`NUM_CHANNELS`, `padWithDefault`, one
sampler per channel) because luma.gl had no uniform arrays when it was written. luma
9.4 does, so Viv could take one texture array plus uniform arrays of colours and
limits with a runtime loop bound, as `rasterTileLayerShaders.ts` does. That drops the
padding and the per-count shader variants, and on WebGL frees texture units.

The harder question is extensions. Viv's colour and contrast extensions inject GLSL
through deck shader hooks, and deck 9.4 has no WGSL hooks (`SHADER_HOOKS_WGSL` is
empty), so on WebGPU an extension means a layer with its own WGSL. MDV's
`VivContrastExtension` and our points colour-by-feature splice both hit this. A shared
answer, whether WGSL hooks in deck, a Viv-owned channel-composite module, or
extensions as layer subclasses, needs agreeing across Viv, MDV and intraspatial
before anything is upstreamed.
