/**
 * Layer renderers for SpatialCanvas
 *
 * Each renderer takes element data and configuration, returning deck.gl layers
 * ready to be composed into the final view.
 */

export { renderImageLayer, type ImageLayerRenderConfig } from './imageRenderer';
export { renderShapesLayer, type ShapesLayerRenderConfig } from './shapesRenderer';
export { renderLabelsLayer, type LabelsLayerRenderConfig } from './labelsRenderer';
