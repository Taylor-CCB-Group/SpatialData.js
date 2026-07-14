import type { SpatialLayerProps } from '@spatialdata/core';
import { spatialLayerPropsSchema } from '@spatialdata/core';
import { CompositeLayer, type Layer, type LayersList } from 'deck.gl';
import {
  createShapesDeckLayer,
  type ShapesLayerPickEvent,
  type ShapesRenderDataLike,
} from './shapesLayer';

export type { SpatialLayerProps };

const defaultProps: Partial<SpatialLayerProps> = {
  schemaVersion: 1,
  viewMode: '2d',
  sublayers: [],
};

export interface SpatialLayerRuntimeProps extends SpatialLayerProps {
  shapeRenderData?: Record<string, ShapesRenderDataLike>;
  spatialCoordinateSystem?: string | null;
  onShapeHover?: (event: ShapesLayerPickEvent) => void;
  onShapeClick?: (event: ShapesLayerPickEvent) => void;
}

/**
 * Top-level deck.gl CompositeLayer for orchestrating spatial sublayers (image, scatter, shapes, …).
 * Sublayer factories are added incrementally; today this layer validates props and returns an empty stack when no deck sublayers are registered.
 */
export class SpatialLayer extends CompositeLayer<SpatialLayerRuntimeProps> {
  static layerName = 'SpatialLayer';
  static defaultProps = defaultProps;

  renderLayers(): Layer | null | LayersList {
    const validated = spatialLayerPropsSchema.parse(this.props);
    if (!validated.sublayers?.length) {
      return [];
    }
    return validated.sublayers
      .map((sublayer, sublayerIndex) => {
        if (sublayer.kind !== 'shapes') {
          return null;
        }
        const renderData = this.props.shapeRenderData?.[sublayer.elementKey];
        if (!renderData) {
          return null;
        }
        return createShapesDeckLayer(renderData, sublayer, {
          id: sublayer.id ?? `shapes-${sublayer.elementKey}-${sublayerIndex}`,
          visible: sublayer.visible,
          spatialCoordinateSystem: this.props.spatialCoordinateSystem,
          onShapeHover: this.props.onShapeHover,
          onShapeClick: this.props.onShapeClick,
        });
      })
      .filter(Boolean);
  }
}
