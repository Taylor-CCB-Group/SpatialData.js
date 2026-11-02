/**
 * Layer renderers for SpatialCanvas.
 *
 * Images only. Shapes and labels rendering moved to their Renderer Adapters in
 * `@spatialdata/layers` (ADR 0004 §4); images stay here with the Viv and
 * `avivatorish` dependencies the ADR's 2026-07-14 amendment keeps out of `core`
 * and `layers`.
 */

export { type ImageLayerRenderConfig, renderImageLayer } from './imageRenderer';
