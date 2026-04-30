/**
 * SpatialViewer - Core rendering component for SpatialCanvas
 *
 * This component handles the composition of Viv image layers with additional
 * deck.gl layers (shapes, points, etc.) following the pattern established in MDV.
 *
 * Uses a unified Viv-compatible pattern:
 * - Always uses Viv's DetailView (even without images)
 * - If image layers present: uses VivSpatialViewer class component
 * - Otherwise: uses simplified functional component with DetailView
 */

import { DetailView } from '@hms-dbmi/viv';
import { DeckGL } from 'deck.gl';
import type { Layer, PickingInfo } from 'deck.gl';
import { useCallback, useId, useMemo } from 'react';
import VivSpatialViewer from './VivSpatialViewer';
import type { ViewState } from './types';
import type { ImageLayerConfig } from './useLayerData';

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
  /** Optional: Viv layer props for image layers */
  vivLayerProps?: ImageLayerConfig[];
  /** Optional: Callback on hover */
  onHover?: (info: PickingInfo) => void;
  /** Optional: Callback on click */
  onClick?: (info: PickingInfo) => void;
}

/**
 * SpatialViewer renders spatial data using deck.gl with Viv-compatible rendering.
 *
 * Uses unified Viv pattern:
 * - If image layers present: uses VivSpatialViewer (class component)
 * - Otherwise: uses DetailView with deck.gl layers (functional component)
 */
export function SpatialViewer({
  width,
  height,
  viewState,
  onViewStateChange,
  layers,
  vivLayerProps,
  onHover,
  onClick,
}: SpatialViewerProps) {
  const hasImageLayers = vivLayerProps && vivLayerProps.length > 0;

  // If we have image layers, use VivSpatialViewer
  if (hasImageLayers) {
    return (
      <VivSpatialViewer
        width={width}
        height={height}
        viewState={viewState}
        onViewStateChange={onViewStateChange}
        vivLayerProps={vivLayerProps}
        extraLayers={layers}
        onHover={onHover}
        onClick={onClick}
      />
    );
  }

  // Otherwise, use simplified DetailView approach (for backward compatibility)
  return (
    <SpatialViewerSimple
      width={width}
      height={height}
      viewState={viewState}
      onViewStateChange={onViewStateChange}
      layers={layers}
      onHover={onHover}
      onClick={onClick}
    />
  );
}

/**
 * Simplified viewer for non-image layers (backward compatibility)
 */
function SpatialViewerSimple({
  width,
  height,
  viewState,
  onViewStateChange,
  layers,
  onHover,
  onClick,
}: Omit<SpatialViewerProps, 'vivLayerProps'>) {
  const viewId = useId();
  const detailViewId = useMemo(() => `spatial-${viewId}`, [viewId]);
  type DeckDetailViewState = {
    id: string;
    target: [number, number, number];
    zoom: number;
    width: number;
    height: number;
  };

  // Use DetailView for consistency with Viv pattern
  const detailView = useMemo(() => {
    return new DetailView({
      id: detailViewId,
      width,
      height,
    });
  }, [detailViewId, width, height]);

  // Convert our ViewState to deck.gl's expected format
  const deckViewState = useMemo((): Record<string, DeckDetailViewState> => {
    if (!viewState) {
      return {
        [detailViewId]: {
          id: detailViewId,
          target: [0, 0, 0],
          zoom: 0,
          width,
          height,
        },
      };
    }
    const [x, y, z = 0] = viewState.target;
    return {
      [detailViewId]: {
        id: detailViewId,
        target: [x, y, z],
        zoom: viewState.zoom,
        width,
        height,
      },
    };
  }, [detailViewId, height, viewState, width]);

  // Handle view state changes from deck.gl
  const handleViewStateChange = useCallback(
    ({ viewState: newVS }: { viewState: Record<string, unknown> }) => {
      const target = newVS.target as [number, number, number];
      onViewStateChange({
        target: [target[0], target[1]],
        zoom: newVS.zoom as number,
      });
    },
    [onViewStateChange]
  );

  // Filter out any null/undefined layers
  const composedLayers = useMemo(() => {
    return layers.filter(Boolean);
  }, [layers]);

  // Don't render if dimensions are invalid
  if (width <= 0 || height <= 0) {
    return null;
  }

  const deckGLView = detailView.getDeckGlView();

  return (
    <DeckGL
      width={width}
      height={height}
      views={deckGLView}
      viewState={deckViewState}
      onViewStateChange={handleViewStateChange}
      layers={composedLayers}
      onHover={onHover}
      onClick={onClick}
      controller={true}
      getCursor={({ isDragging }) => (isDragging ? 'grabbing' : 'crosshair')}
      style={{ backgroundColor: '#111' }}
    />
  );
}
