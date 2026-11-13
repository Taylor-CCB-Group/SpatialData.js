/**
 * SpatialViewer - Core rendering component for SpatialCanvas
 *
 * This component handles the composition of Viv image layers with additional
 * deck.gl layers (shapes, points, etc.) following the pattern established in MDV.
 */

import type { Layer, PickingInfo } from '@deck.gl/core';
import type { DeckGLProps, DeckGLRef } from '@deck.gl/react';
import type { RenderStack } from '@spatialdata/layers';
import type { RefObject } from 'react';
import type { ViewState } from './types';
import type { ImageLayerConfig } from './useLayerData';
import VivSpatialViewer from './VivSpatialViewer';

// Stable so VivSpatialViewer (a PureComponent) doesn't see a new prop each render.
const NO_IMAGE_LAYERS: ImageLayerConfig[] = [];

export interface SpatialViewerProps {
  /** Viewport width */
  width: number;
  /** Viewport height */
  height: number;
  /** View state (pan/zoom) */
  viewState: ViewState | null;
  /** Callback when view state changes */
  onViewStateChange: (vs: ViewState) => void;
  /** deck.gl layers to render (shapes, points, etc.) */
  layers: Layer[];
  /** Global SpatialCanvas layer order, bottom to top. */
  layerOrder?: string[];
  /**
   * When given, layers are placed by this stack's tree instead of `layerOrder`, and its
   * isolated groups are drawn. `layers` and `vivLayerProps` are matched to entries by id.
   *
   * They are drawn as given, so they must already carry the visibility and opacity
   * their entries inherit from pass-through groups, as `useSpatialCanvasRenderer`
   * builds them. It can't be applied here: Viv's image layer ignores an outer
   * `opacity`, so it has to go in when a layer is built.
   */
  renderStack?: RenderStack;
  /** Optional: Viv layer props for image layers */
  vivLayerProps?: ImageLayerConfig[];
  /** Optional: Callback on hover */
  onHover?: (info: PickingInfo) => void;
  /** Optional: Callback on click */
  onClick?: (info: PickingInfo) => void;
  /** Optional: Additional deck.gl props */
  deckProps?: Partial<DeckGLProps>;
  /** Ref to the underlying Deck instance (for multi-layer tooltip picking). */
  deckRef?: RefObject<DeckGLRef | null>;
}

/**
 * SpatialViewer renders spatial data using deck.gl with Viv-compatible rendering.
 *
 * Always renders VivSpatialViewer, with or without image layers, so the Deck
 * (and its GPU device) survives image layers being added, removed or hidden.
 */
export function SpatialViewer({
  width,
  height,
  viewState,
  onViewStateChange,
  layers,
  layerOrder,
  renderStack,
  vivLayerProps,
  onHover,
  onClick,
  deckProps,
  deckRef,
}: SpatialViewerProps) {
  return (
    <VivSpatialViewer
      width={width}
      height={height}
      viewState={viewState}
      onViewStateChange={onViewStateChange}
      vivLayerProps={vivLayerProps ?? NO_IMAGE_LAYERS}
      extraLayers={layers}
      layerOrder={layerOrder}
      renderStack={renderStack}
      onHover={onHover}
      onClick={onClick}
      deckProps={deckProps}
      deckRef={deckRef}
    />
  );
}
