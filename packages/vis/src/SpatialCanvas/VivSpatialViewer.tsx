/**
 * VivSpatialViewer - Class component for rendering Viv image layers with additional deck.gl layers
 * 
 * This component follows the MDVivViewer pattern from MDV, adapted for SpatialCanvas.
 * It handles:
 * - Viv DetailView management
 * - View state synchronization
 * - Composing Viv layers (from view.getLayers()) with extra deck.gl layers
 * - Scale bar positioning
 * - Layer filtering for multi-view support
 * 
 * Structured to allow gradual refactoring to hooks in the future.
 */

import * as React from 'react';
import { _flatten } from '@deck.gl/core';
import { DeckGL } from 'deck.gl';
import equal from 'fast-deep-equal';
import { ScaleBarLayer, DetailView, getDefaultInitialViewState } from '@hms-dbmi/viv';
import type { OrthographicViewState, OrbitViewState, DeckGLProps, Layer, LayersList, PickingInfo } from 'deck.gl';
import type { ViewState } from './types';
import type { ImageLayerConfig } from './useLayerData';

const SHOULD_DEBUG_DECK =
  typeof window !== 'undefined' &&
  (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

export function getVivId(id: string): string {
  return `-#${id}#`;
}

export type VivViewState = (OrthographicViewState | OrbitViewState) & { id: string };
export type VivViewStates = VivViewState[];
export type View = { id: string } & any; // Viv View type
export type VivPickInfo = PickingInfo<any, any> & { tile?: any };

const areViewStatesEqual = (viewState: VivViewState, otherViewState?: VivViewState): boolean => {
  return (
    otherViewState === viewState ||
    (viewState?.zoom === otherViewState?.zoom &&
      // @ts-expect-error - CBA to discriminate between Orbit and Ortho viewStates
      viewState?.rotationX === otherViewState?.rotationX &&
      // @ts-expect-error
      viewState?.rotationOrbit === otherViewState?.rotationOrbit &&
      equal(viewState?.target, otherViewState?.target))
  );
};

export interface VivSpatialViewerProps {
  /** Viv layer props (loader + channel config) */
  vivLayerProps: ImageLayerConfig[];
  /** Extra deck.gl layers (shapes, points, etc.) */
  extraLayers?: Layer[];
  /** Viewport width */
  width: number;
  /** Viewport height */
  height: number;
  /** View state (pan/zoom) */
  viewState: ViewState | null;
  /** Callback when view state changes */
  onViewStateChange: (vs: ViewState) => void;
  /** Optional: Callback on hover */
  onHover?: (info: PickingInfo) => void;
  /** Optional: Callback on click */
  onClick?: (info: PickingInfo) => void;
  /** Optional: Additional deck.gl props */
  deckProps?: Partial<DeckGLProps>;
}

interface VivSpatialViewerState {
  viewStates: Record<string, VivViewState>;
  // deckRef?: React.MutableRefObject<DeckGL>;
}

/**
 * Pure function to compose layers: [vivImageLayers, ...extraLayers, scaleBarLayer]
 * Note: extraLayers (shapes/points) render on top of images
 * 
 * This matches MDVivViewer's pattern exactly:
 * - When deckProps.layers exists: [otherLayers (images), ...deckProps.layers (shapes), scaleBar]
 * - When deckProps.layers is undefined: [vivLayers (all), scaleBar]
 */
function composeLayers(
  vivLayers: LayersList,
  extraLayers: LayersList = [],
  deckPropsLayers?: LayersList
): LayersList {
  // Separate scale bar from other Viv layers
  const scaleBarLayer = vivLayers.find((layer) => layer instanceof ScaleBarLayer);
  const otherVivLayers = vivLayers.filter((layer) => layer !== scaleBarLayer);

  // Follow MDV pattern: [otherLayers (images), ...deckProps.layers (shapes), scaleBar]
  // In our case, extraLayers = shapes/points (equivalent to deckProps.layers in MDV)
  // Always compose: [image layers, ...extraLayers, ...deckPropsLayers, scaleBar]
  const layers: LayersList = [];
  
  // Add image layers (without scale bar) first - these render at the bottom
  if (otherVivLayers.length > 0) {
    layers.push(...otherVivLayers);
  }
  
  // Add extra layers (shapes/points) - these render on top of images
  // This is equivalent to deckProps.layers in MDV
  if (extraLayers.length > 0) {
    layers.push(...extraLayers);
  }
  
  // Add any additional deckProps layers
  if (deckPropsLayers && deckPropsLayers.length > 0) {
    layers.push(...deckPropsLayers);
  }
  
  // Scale bar always on top
  if (scaleBarLayer) {
    layers.push(scaleBarLayer);
  }
  
  return layers;
}

/**
 * Convert SpatialCanvas ViewState to Viv ViewState format
 */
function toVivViewState(viewState: ViewState, viewId: string, width: number, height: number): VivViewState {
  const [x, y, z = 0] = viewState.target;
  return {
    id: viewId,
    target: [x, y, z],
    zoom: viewState.zoom,
    // @ts-expect-error - Viv ViewState may have additional properties
    width,
    height,
  };
}

/**
 * Convert Viv ViewState to SpatialCanvas ViewState format
 */
function fromVivViewState(vivViewState: VivViewState): ViewState {
  const target = vivViewState.target as [number, number, number];
  // still not exactly happy with this, and pending 3d etc
  // do we need our own ViewState types that don't match deck?
  const zoom = Array.isArray(vivViewState.zoom)
    ? vivViewState.zoom[0]
    : (vivViewState.zoom ?? 0);
  return {
    target: [target[0], target[1]],
    zoom,
  };
}

class VivSpatialViewer extends React.PureComponent<VivSpatialViewerProps, VivSpatialViewerState> {
  private detailView: DetailView;
  private viewId: string;

  constructor(props: VivSpatialViewerProps) {
    super(props);
    this.viewId = `spatial-detail-${Math.random().toString(36).substr(2, 9)}`;
    
    // Create DetailView
    this.detailView = new DetailView({
      id: this.viewId,
      snapScaleBar: true,
      width: props.width,
      height: props.height,
    });

    // Initialize view state
    const initialViewState = props.viewState
      ? toVivViewState(props.viewState, this.viewId, props.width, props.height)
      : this.getDefaultViewState();

    this.state = {
      viewStates: {
        [this.viewId]: initialViewState,
      },
      // deckRef: React.createRef(),
    };

    this._onViewStateChange = this._onViewStateChange.bind(this);
    this.layerFilter = this.layerFilter.bind(this);
  }

  private getDefaultViewState(): VivViewState {
    // If we have a loader, use Viv's default initial view state
    if (this.props.vivLayerProps.length > 0 && this.props.vivLayerProps[0].loader) {
      try {
        const loader = this.props.vivLayerProps[0].loader as any;
        const defaultState = getDefaultInitialViewState(loader, {
          width: this.props.width,
          height: this.props.height,
        });
        return {
          ...defaultState,
          id: this.viewId,
        } as VivViewState;
      } catch (e) {
        console.warn('Failed to get default view state from loader:', e);
      }
    }

    // Fallback to centered view
    return {
      id: this.viewId,
      target: [0, 0, 0],
      zoom: 0,
      width: this.props.width,
      height: this.props.height,
    } as VivViewState;
  }

  componentDidUpdate(prevProps: VivSpatialViewerProps) {
    const { width, height, viewState } = this.props;

    // Update view dimensions if changed
    if (width !== prevProps.width || height !== prevProps.height) {
      this.detailView.width = width;
      this.detailView.height = height;
    }

    // Update view state if changed externally
    if (viewState && !areViewStatesEqual(
      toVivViewState(viewState, this.viewId, width, height),
      this.state.viewStates[this.viewId]
    )) {
      this.setState((prevState) => ({
        viewStates: {
          ...prevState.viewStates,
          [this.viewId]: toVivViewState(viewState, this.viewId, width, height),
        },
      }));
    }
  }

  layerFilter({ layer, viewport }: { layer: Layer; viewport: any }): boolean {
    return layer.id.includes(getVivId(viewport.id));
  }

  _onViewStateChange({ viewId, viewState }: { viewId: string; viewState: VivViewState }): VivViewState {
    const { onViewStateChange } = this.props;

    // Update internal state
    this.setState((prevState) => ({
      viewStates: {
        ...prevState.viewStates,
        [viewId]: viewState,
      },
    }));

    // Notify parent
    if (onViewStateChange) {
      onViewStateChange(fromVivViewState(viewState));
    }

    return viewState;
  }

  _renderLayers(): LayersList {
    const { vivLayerProps, extraLayers, deckProps, onHover } = this.props;
    const { viewStates } = this.state;

    // Shared by all paths: layerFilter requires layer IDs to include the Viv viewport token
    const vivId = getVivId(this.viewId);
    const withVivId = (layer: Layer) =>
      layer.id.includes(vivId) ? layer : layer.clone({ id: `${layer.id}${vivId}` });

    const extraLayersWithVivId = (extraLayers || []).map(withVivId);
    // `deckProps.layers` is LayersList (nested arrays, falsy slots); LayerManager normalizes with the same flatten + Boolean filter.
    const deckLayersFlat = _flatten(deckProps?.layers ?? [], Boolean) as Layer[];
    const deckPropsLayersWithVivId = deckLayersFlat.map(withVivId);

    // Viv typically handles one loader per view
    // For now, use the first image layer (can be extended later for multiple images per view)
    if (vivLayerProps.length === 0) {
      return composeLayers([], extraLayersWithVivId, deckPropsLayersWithVivId);
    }

    const firstLayerProps = vivLayerProps[0];

    // Get Viv layers from view
    const layerProps: Record<string, unknown> = {
      loader: firstLayerProps.loader,
      colors: firstLayerProps.colors,
      contrastLimits: firstLayerProps.contrastLimits,
      channelsVisible: firstLayerProps.channelsVisible,
      selections: firstLayerProps.selections,
      onHover,
    };

    // Let Viv/deck merge these with layer defaultProps (including `extensions`).
    // Do not patch `layer.props` afterward with `{ ...layer.props, opacity }` — that spread
    // drops non-enumerable props like `extensions` and breaks MultiscaleImageLayer._update.
    if (firstLayerProps.opacity !== undefined) {
      layerProps.opacity = firstLayerProps.opacity;
    }
    if (firstLayerProps.visible !== undefined) {
      layerProps.visible = firstLayerProps.visible;
    }
    if (firstLayerProps.modelMatrix) {
      layerProps.modelMatrix = firstLayerProps.modelMatrix;
    }

    const vivLayersResult = this.detailView.getLayers({
      viewStates,
      props: layerProps,
    });

    // getLayers returns an array of arrays (one per view)
    // For a single view, take the first element (like MDVivViewer does at line 385)
    const vivLayers = Array.isArray(vivLayersResult) && vivLayersResult.length > 0
      ? (Array.isArray(vivLayersResult[0]) ? vivLayersResult[0] : vivLayersResult) as Layer[]
      : [];

    // Compose with extra layers - following MDV pattern exactly
    // MDV does: [otherLayers (images), ...deckProps.layers (shapes), scaleBar]
    return composeLayers(vivLayers, extraLayersWithVivId, deckPropsLayersWithVivId);
  }

  render() {
    const { width, height, onHover, onClick, deckProps } = this.props;
    const { viewStates } = this.state;

    if (width <= 0 || height <= 0) {
      return null;
    }

    const layers = this._renderLayers();
    const deckGLView = this.detailView.getDeckGlView();

    return (
      <DeckGL
        // ref={this.state.deckRef}
        {...(deckProps ?? {})}
        layerFilter={this.layerFilter}
        layers={layers}
        //@ts-expect-error onViewStateChange
        onViewStateChange={this._onViewStateChange}
        views={deckGLView}
        viewState={viewStates}
        useDevicePixels={deckProps?.useDevicePixels ?? true}
        debug={deckProps?.debug ?? SHOULD_DEBUG_DECK}
        getCursor={({ isDragging }) => (isDragging ? 'grabbing' : 'crosshair')}
        onHover={onHover}
        onClick={onClick}
        style={{ backgroundColor: '#111', ...deckProps?.style }}
      />
    );
  }
}

export { VivSpatialViewer };
export default VivSpatialViewer;
