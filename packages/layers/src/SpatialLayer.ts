import { CompositeLayer, type Layer } from 'deck.gl';
import type { SpatialLayerProps } from './spatialLayerProps';
import { spatialLayerPropsSchema } from './spatialLayerProps';

export type { SpatialLayerProps };

const defaultProps: Partial<SpatialLayerProps> = {
  schemaVersion: 1,
  viewMode: '2d',
  sublayers: [],
};

/**
 * Top-level deck.gl CompositeLayer for orchestrating spatial sublayers (image, scatter, shapes, …).
 * Sublayer factories are added incrementally; today this layer validates props and returns an empty stack when no deck sublayers are registered.
 */
export class SpatialLayer extends CompositeLayer<SpatialLayerProps> {
  static layerName = 'SpatialLayer';
  static defaultProps = defaultProps;

  renderLayers(): Layer[] | null {
    const validated = spatialLayerPropsSchema.parse(this.props);
    if (!validated.sublayers?.length) {
      return [];
    }
    // Future: map validated.sublayers to Viv / Scatterplot / GeoJsonLayer instances via @spatialdata/avivatorish + core adapters.
    return [];
  }
}
