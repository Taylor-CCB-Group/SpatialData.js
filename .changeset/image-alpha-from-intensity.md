---
"@spatialdata/layers": minor
"@spatialdata/vis": minor
---

Image layers take an `alphaFromIntensity: { threshold, gain }` option that sets opacity from brightness, so a dark-background image such as fluorescence or IMC can be drawn over brightfield like H&E. It works on WebGL and WebGPU and is saved with the image's Render Stack entry props.
