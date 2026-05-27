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
import type { Deck } from '@deck.gl/core';
import { DeckGL } from 'deck.gl';
import type { DeckGLProps, DeckGLRef, Layer, PickingInfo } from 'deck.gl';
import { useCallback, useId, useMemo, type RefObject } from 'react';
import VivSpatialViewer, { normalizeVivLayers } from './VivSpatialViewer';
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
  /** Global SpatialCanvas layer order, bottom to top. */
  layerOrder?: string[];
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
  layerOrder,
  vivLayerProps,
  onHover,
  onClick,
  deckProps,
  deckRef,
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
        layerOrder={layerOrder}
        onHover={onHover}
        onClick={onClick}
        deckProps={deckProps}
        deckRef={deckRef}
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
      deckProps={deckProps}
      deckRef={deckRef}
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
  deckProps,
  deckRef,
}: Omit<SpatialViewerProps, 'vivLayerProps' | 'layerOrder'>) {
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
    return [...layers.filter(Boolean), ...normalizeVivLayers(deckProps?.layers ?? [])];
  }, [deckProps?.layers, layers]);

  // Don't render if dimensions are invalid
  if (width <= 0 || height <= 0) {
    return null;
  }

  const deckGLView = detailView.getDeckGlView();

  return (
    <DeckGL
      ref={deckRef}
      {...(deckProps ?? {})}
      width={width}
      height={height}
      views={deckGLView}
      viewState={deckViewState}
      onViewStateChange={handleViewStateChange}
      layers={composedLayers}
      onHover={onHover}
      onClick={onClick}
      controller={deckProps?.controller ?? true}
      getCursor={({ isDragging }) => (isDragging ? 'grabbing' : 'crosshair')}
      style={{ backgroundColor: '#111', ...deckProps?.style }}
    />
  );
}
