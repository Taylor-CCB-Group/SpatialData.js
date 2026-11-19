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

import {
  type Layer,
  type LayersList,
  type OrbitViewState,
  OrthographicView,
  type OrthographicViewState,
  type PickingInfo,
} from '@deck.gl/core';
import type { DeckGLProps, DeckGLRef } from '@deck.gl/react';
import { DeckGL } from '@deck.gl/react';
import { getDefaultInitialViewState, ScaleBarLayer } from '@hms-dbmi/viv';
import type { RenderStack } from '@spatialdata/layers';
import { DetailView } from '@vivjs/views';
import equal from 'fast-deep-equal';
import * as React from 'react';
import { withWebGPUFixes } from './deckDevice';
import { renderStackOrder, renderStackToDeckLayers } from './renderStackAdapters';
import type { ScaleBarSize } from './scaleBar';
import type { ViewState } from './types';
import type { ImageLayerConfig } from './useLayerData';
import { getVivId, normalizeVivLayers, vivImageLayers } from './vivImageLayers';

export type VivViewState = (OrthographicViewState | OrbitViewState) & { id: string };
export type VivViewStates = VivViewState[];
// biome-ignore lint/suspicious/noExplicitAny: tracked in #257
export type View = { id: string } & any; // Viv View type
// biome-ignore lint/suspicious/noExplicitAny: tracked in #257
export type VivPickInfo = PickingInfo<any, any> & { tile?: any };
type VivZoom = number | readonly number[] | null | undefined;
type VivDefaultInitialViewStateWithModelMatrix = (
  loader: object,
  viewSize: { width: number; height: number },
  zoomBackOff?: number,
  use3d?: boolean,
  modelMatrix?: ImageLayerConfig['modelMatrix']
) => object;

// Viv's 0.21 declaration says `modelMatrix` is boolean, but the runtime calls
// Matrix4 methods on it. Keep the compatibility cast at this external boundary.
const getDefaultInitialViewStateWithModelMatrix =
  getDefaultInitialViewState as unknown as VivDefaultInitialViewStateWithModelMatrix;

export function normalizeVivZoom(zoom: VivZoom): number {
  if (Array.isArray(zoom)) {
    return zoom[0] ?? 0;
  }
  if (typeof zoom === 'number') {
    return zoom;
  }
  return 0;
}

const areViewStatesEqual = (viewState: VivViewState, otherViewState?: VivViewState): boolean => {
  return (
    otherViewState === viewState ||
    (normalizeVivZoom(viewState?.zoom) === normalizeVivZoom(otherViewState?.zoom) &&
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
  /** Global SpatialCanvas layer order, bottom to top. */
  layerOrder?: string[];
  /** Places layers by the stack's tree, with its groups, instead of `layerOrder`. */
  renderStack?: RenderStack;
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
  /** Ref to the underlying Deck instance (for multi-layer tooltip picking). */
  deckRef?: React.RefObject<DeckGLRef | null>;
  /** Physical length of one view unit; draws a scale bar when given. */
  scaleBar?: ScaleBarSize;
}

interface VivSpatialViewerState {
  viewStates: Record<string, VivViewState>;
  // deckRef?: React.MutableRefObject<DeckGL>;
}

interface OrderedLayerRecord {
  layer: Layer;
  orderId?: string;
}

function stripVivId(id: string, vivId: string): string {
  return id.includes(vivId) ? id.replace(vivId, '') : id;
}

function sortLayerRecords(records: OrderedLayerRecord[], layerOrder?: string[]): Layer[] {
  if (!layerOrder?.length) {
    return records.map((record) => record.layer);
  }
  const orderIndex = new Map(layerOrder.map((id, index) => [id, index]));
  return records
    .map((record, originalIndex) => ({
      ...record,
      originalIndex,
      order: record.orderId === undefined ? undefined : orderIndex.get(record.orderId),
    }))
    .sort((a, b) => {
      if (a.order === undefined && b.order === undefined) {
        return a.originalIndex - b.originalIndex;
      }
      if (a.order === undefined) {
        return 1;
      }
      if (b.order === undefined) {
        return -1;
      }
      return a.order - b.order;
    })
    .map((record) => record.layer);
}

/**
 * Layers placed by the stack's tree, with its groups built. Records no stack entry
 * claims go on top, in their own order. Members already carry the view token; a
 * group is a new top-level layer, so it is given one here.
 */
function placeLayerRecords(
  records: OrderedLayerRecord[],
  renderStack: RenderStack,
  withViewToken: (layer: Layer) => Layer
): Layer[] {
  const stackIds = new Set(renderStackOrder(renderStack, []));
  const entryLayers = new Map<string, Layer[]>();
  const unplaced: Layer[] = [];
  for (const { layer, orderId } of records) {
    if (orderId === undefined || !stackIds.has(orderId)) {
      unplaced.push(layer);
      continue;
    }
    entryLayers.set(orderId, [...(entryLayers.get(orderId) ?? []), layer]);
  }
  return [...renderStackToDeckLayers(renderStack, { entryLayers }).map(withViewToken), ...unplaced];
}

function composeLayers(
  orderedLayers: OrderedLayerRecord[],
  deckPropsLayers: LayersList = [],
  scaleBarLayer?: Layer,
  layerOrder?: string[],
  placement?: { renderStack: RenderStack; withViewToken: (layer: Layer) => Layer }
): LayersList {
  const layers: LayersList = placement
    ? placeLayerRecords(orderedLayers, placement.renderStack, placement.withViewToken)
    : sortLayerRecords(orderedLayers, layerOrder);

  // Caller-supplied deckProps layers are not necessarily SpatialData layers, so
  // keep them above the generated stack unless a future API gives them order ids.
  if (deckPropsLayers.length > 0) {
    layers.push(...deckPropsLayers);
  }

  if (scaleBarLayer) {
    layers.push(scaleBarLayer);
  }

  return layers;
}

/**
 * Convert SpatialCanvas ViewState to Viv ViewState format
 */
function toVivViewState(
  viewState: ViewState,
  viewId: string,
  width: number,
  height: number
): VivViewState {
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
  const zoom = normalizeVivZoom(vivViewState.zoom);
  return {
    target: [target[0], target[1]],
    zoom,
  };
}

function findLayerWithLoader(vivLayerProps: ImageLayerConfig[]): ImageLayerConfig | undefined {
  return vivLayerProps.find((layerProps) => layerProps.loader);
}

class VivSpatialViewer extends React.PureComponent<VivSpatialViewerProps, VivSpatialViewerState> {
  private detailView: DetailView;
  private viewId: string;
  private scaleBarViewId: string;

  constructor(props: VivSpatialViewerProps) {
    super(props);
    this.viewId = `spatial-detail-${Math.random().toString(36).substr(2, 9)}`;
    this.scaleBarViewId = `${this.viewId}-scalebar`;

    // Create DetailView
    this.detailView = new DetailView({
      id: this.viewId,
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
        [this.scaleBarViewId]: this.getScaleBarViewState(),
      },
      // deckRef: React.createRef(),
    };

    this._onViewStateChange = this._onViewStateChange.bind(this);
    this.layerFilter = this.layerFilter.bind(this);
  }

  private getDefaultViewState(): VivViewState {
    const firstLayerWithLoader = findLayerWithLoader(this.props.vivLayerProps);

    // If we have a loader, use Viv's default initial view state
    if (
      firstLayerWithLoader &&
      firstLayerWithLoader.loader !== null &&
      typeof firstLayerWithLoader.loader === 'object'
    ) {
      try {
        const defaultState = getDefaultInitialViewStateWithModelMatrix(
          firstLayerWithLoader.loader,
          {
            width: this.props.width,
            height: this.props.height,
          },
          0,
          false,
          firstLayerWithLoader.modelMatrix
        );
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

  private getScaleBarViewState(): VivViewState {
    return {
      id: this.scaleBarViewId,
      target: [this.props.width / 2, this.props.height / 2, 0],
      zoom: 0,
      width: this.props.width,
      height: this.props.height,
    } as VivViewState;
  }

  // What Viv's `ScaleBarView` builds, without its image loader: the bar measures
  // the view's own units, so it doesn't need an image.
  private getScaleBarDeckView(): OrthographicView | undefined {
    if (!this.props.scaleBar) {
      return undefined;
    }
    const { width, height } = this.props;
    return new OrthographicView({ id: this.scaleBarViewId, controller: false, width, height });
  }

  private getScaleBarLayer(): Layer | undefined {
    const { scaleBar, width, height } = this.props;
    const imageViewState = this.state.viewStates[this.viewId];
    if (!scaleBar || !imageViewState) {
      return undefined;
    }
    // Viv's declaration leaves out `width` and `height`, which the layer reads to
    // place the bar; a spread passes them without an excess-property error.
    const viewSize = { width, height };
    return new ScaleBarLayer({
      id: getVivId(this.scaleBarViewId),
      unit: scaleBar.unit,
      size: scaleBar.size,
      imageViewState: { ...imageViewState },
      snap: true,
      ...viewSize,
    });
  }

  componentDidUpdate(prevProps: VivSpatialViewerProps) {
    const { width, height, viewState } = this.props;
    const nextViewStates: Record<string, VivViewState> = { ...this.state.viewStates };
    let viewStatesChanged = false;

    // Update view dimensions if changed
    if (width !== prevProps.width || height !== prevProps.height) {
      this.detailView.width = width;
      this.detailView.height = height;
      nextViewStates[this.viewId] = {
        ...nextViewStates[this.viewId],
        width,
        height,
      } as unknown as VivViewState;
      nextViewStates[this.scaleBarViewId] = this.getScaleBarViewState();
      viewStatesChanged = true;
    }

    // Without a host view state, frame the first image loader to arrive. The
    // viewer stays mounted across image layers coming and going, so this can't
    // rely on the constructor.
    if (
      !viewState &&
      !findLayerWithLoader(prevProps.vivLayerProps) &&
      findLayerWithLoader(this.props.vivLayerProps)
    ) {
      nextViewStates[this.viewId] = this.getDefaultViewState();
      viewStatesChanged = true;
    }

    // Update view state if changed externally
    if (
      viewState &&
      !areViewStatesEqual(
        toVivViewState(viewState, this.viewId, width, height),
        this.state.viewStates[this.viewId]
      )
    ) {
      nextViewStates[this.viewId] = toVivViewState(viewState, this.viewId, width, height);
      viewStatesChanged = true;
    }

    if (viewStatesChanged) {
      this.setState({ viewStates: nextViewStates });
    }
  }

  // biome-ignore lint/suspicious/noExplicitAny: tracked in #257
  layerFilter({ layer, viewport }: { layer: Layer; viewport: any }): boolean {
    return layer.id.includes(getVivId(viewport.id));
  }

  _onViewStateChange({
    viewId,
    viewState,
  }: {
    viewId: string;
    viewState: VivViewState;
  }): VivViewState {
    const { onViewStateChange } = this.props;

    // Update internal state
    this.setState((prevState) => ({
      viewStates: {
        ...prevState.viewStates,
        [viewId]: viewState,
      },
    }));

    // Notify parent
    if (viewId === this.viewId && onViewStateChange) {
      onViewStateChange(fromVivViewState(viewState));
    }

    return viewState;
  }

  _renderLayers(): LayersList {
    const { vivLayerProps, extraLayers, layerOrder, renderStack, deckProps, onHover } = this.props;

    // Shared by all paths: layerFilter requires layer IDs to include the Viv viewport token
    const vivId = getVivId(this.viewId);
    const withVivId = (layer: Layer) =>
      layer.id.includes(vivId) ? layer : layer.clone({ id: `${layer.id}${vivId}` });

    const extraLayerRecords: OrderedLayerRecord[] = (extraLayers || []).map((layer) => {
      const layerWithVivId = withVivId(layer);
      return {
        layer: layerWithVivId,
        orderId: stripVivId(layerWithVivId.id, vivId),
      };
    });
    const deckPropsLayersWithVivId = normalizeVivLayers(deckProps?.layers ?? []).map(withVivId);
    const placement = renderStack ? { renderStack, withViewToken: withVivId } : undefined;

    const orderedLayers: OrderedLayerRecord[] = [...extraLayerRecords];
    for (const [orderId, layers] of vivImageLayers(vivLayerProps, {
      viewId: this.viewId,
      // As `DetailView` does: its tiles follow this view only.
      viewportId: this.viewId,
      onHover,
    })) {
      orderedLayers.push(...layers.map((layer) => ({ layer, orderId })));
    }

    return composeLayers(
      orderedLayers,
      deckPropsLayersWithVivId,
      this.getScaleBarLayer(),
      layerOrder,
      placement
    );
  }

  render() {
    const { width, height, onHover, onClick, deckProps } = this.props;
    const { viewStates } = this.state;

    if (width <= 0 || height <= 0) {
      return null;
    }

    const layers = this._renderLayers();
    const scaleBarView = this.getScaleBarDeckView();
    // Viv's detail view hardcodes `controller: true`, and deck only applies a
    // top-level `controller` prop when it is truthy, so `false` must go on the view.
    const detailDeckView = this.detailView
      .getDeckGlView()
      .clone({ controller: deckProps?.controller ?? true });
    const deckGLViews = scaleBarView ? [detailDeckView, scaleBarView] : detailDeckView;

    return (
      <DeckGL
        ref={this.props.deckRef}
        {...(deckProps ?? {})}
        layerFilter={this.layerFilter}
        layers={layers}
        //@ts-expect-error onViewStateChange
        onViewStateChange={this._onViewStateChange}
        views={deckGLViews}
        viewState={viewStates}
        useDevicePixels={deckProps?.useDevicePixels ?? true}
        getCursor={({ isDragging }) => (isDragging ? 'grabbing' : 'crosshair')}
        onHover={onHover}
        onClick={onClick}
        onDeviceInitialized={withWebGPUFixes(deckProps?.onDeviceInitialized)}
        style={{ backgroundColor: '#111', ...deckProps?.style }}
      />
    );
  }
}

export { VivSpatialViewer };
export default VivSpatialViewer;
