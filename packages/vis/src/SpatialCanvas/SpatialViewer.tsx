/**
 * SpatialViewer - Core rendering component for SpatialCanvas
 * 
 * This component handles the composition of Viv image layers with additional
 * deck.gl layers (shapes, points, etc.) following the pattern established in MDV.
 * 
 * The key insight from MDV is that Viv's VivViewer needs special handling:
 * - Viv views have their own layer rendering via view.getLayers()
 * - Extra layers need to be composed in the right order
 * - Layer filtering is needed for multi-view support
 * 
 * For now, this provides a simpler deck.gl-only implementation that can be
 * extended to use Viv's view system when image layer support is added.
 */

import { useCallback, useMemo, useId } from 'react';
import { DeckGL, OrthographicView } from 'deck.gl';
import type { Layer, PickingInfo } from 'deck.gl';
import type { ViewState } from './types';

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
  /** Optional: Viv layer configuration for images (to be implemented) */
  vivLayerProps?: unknown[];
  /** Optional: Callback on hover */
  onHover?: (info: PickingInfo) => void;
  /** Optional: Callback on click */
  onClick?: (info: PickingInfo) => void;
}

/**
 * SpatialViewer renders spatial data using deck.gl with an orthographic view.
 * 
 * This is a simplified version that handles deck.gl layers directly.
 * For full Viv image support, this will need to be extended to follow
 * MDV's MDVivViewer pattern of composing Viv's view.getLayers() output
 * with additional deck.gl layers.
 * 
 * @see MDV/src/react/components/avivatorish/MDVivViewer.tsx for the full pattern
 */
export function SpatialViewer({
  width,
  height,
  viewState,
  onViewStateChange,
  layers,
  vivLayerProps: _vivLayerProps, // Reserved for future Viv integration
  onHover,
  onClick,
}: SpatialViewerProps) {
  const viewId = useId();

  // Create orthographic view for 2D spatial data
  const view = useMemo(() => {
    return new OrthographicView({
      id: `spatial-${viewId}`,
      flipY: false, // Spatial data typically has Y increasing upward
      controller: true,
    });
  }, [viewId]);

  // Convert our ViewState to deck.gl's expected format
  const deckViewState = useMemo((): { target: [number, number, number]; zoom: number } => {
    if (!viewState) {
      // Default view state centered at origin
      return {
        target: [0, 0, 0],
        zoom: 0,
      };
    }
    const [x, y, z = 0] = viewState.target;
    return {
      target: [x, y, z],
      zoom: viewState.zoom,
    };
  }, [viewState]);

  // Handle view state changes from deck.gl
  const handleViewStateChange = useCallback(({ viewState: newVS }: { viewState: Record<string, unknown> }) => {
    const target = newVS.target as [number, number, number];
    onViewStateChange({
      target: [target[0], target[1]],
      zoom: newVS.zoom as number,
    });
  }, [onViewStateChange]);

  // Compose layers
  // TODO: When Viv support is added, this will need to:
  // 1. Get Viv layers via view.getLayers({ viewStates, props: vivLayerProps })
  // 2. Separate out scale bar layer
  // 3. Compose: [vivImageLayers, ...extraLayers, scaleBarLayer]
  const composedLayers = useMemo(() => {
    // For now, just use the provided layers directly
    // Filter out any null/undefined layers
    return layers.filter(Boolean);
  }, [layers]);

  // Don't render if dimensions are invalid
  if (width <= 0 || height <= 0) {
    return null;
  }

  return (
    <DeckGL
      width={width}
      height={height}
      views={view}
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

/**
 * Future: VivSpatialViewer
 * 
 * When we need full Viv image layer support, we'll create a component
 * similar to MDV's MDVivViewer that:
 * 
 * 1. Takes vivLayerProps (loader, channels, etc.)
 * 2. Creates a DetailView from Viv
 * 3. Gets image layers via view.getLayers()
 * 4. Composes with extra deck.gl layers
 * 5. Handles Viv's scale bar positioning
 * 
 * This will likely need to be a class component to match Viv's patterns,
 * or we'll need to carefully translate the logic to hooks.
 */

