/**
 * Layer renderers for SpatialCanvas
 *
 * Each renderer takes element data and configuration, returning deck.gl layers
 * ready to be composed into the final view.
 */

export { type ImageLayerRenderConfig, renderImageLayer } from './imageRenderer';
export { type LabelsLayerRenderConfig, renderLabelsLayer } from './labelsRenderer';
export { renderShapesLayer, type ShapesLayerRenderConfig } from './shapesRenderer';
