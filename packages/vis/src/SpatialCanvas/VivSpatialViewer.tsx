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

import { ScaleBarLayer, getDefaultInitialViewState } from '@hms-dbmi/viv';
import { DetailView, ScaleBarView } from '@vivjs/views';
import { DeckGL } from 'deck.gl';
import type {
  DeckGLProps,
  DeckGLRef,
  Layer,
  LayersList,
  OrbitViewState,
  OrthographicViewState,
  PickingInfo,
} from 'deck.gl';
import equal from 'fast-deep-equal';
import * as React from 'react';
import type { ViewState } from './types';
import type { ImageLayerConfig } from './useLayerData';

export function getVivId(id: string): string {
  return `-#${id}#`;
}

export type VivViewState = (OrthographicViewState | OrbitViewState) & { id: string };
export type VivViewStates = VivViewState[];
export type View = { id: string } & any; // Viv View type
export type VivPickInfo = PickingInfo<any, any> & { tile?: any };
type VivZoom = number | readonly number[] | null | undefined;
type VivLoader = { meta?: { physicalSizes?: { x?: { size: number; unit: string } } } };
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

function isLayerLike(value: unknown): value is Layer {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const id = Reflect.get(value, 'id');
  const clone = Reflect.get(value, 'clone');
  return typeof id === 'string' && typeof clone === 'function';
}

export function normalizeVivLayers(raw: unknown): Layer[] {
  if (isLayerLike(raw)) {
    return [raw];
  }
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((entry) => normalizeVivLayers(entry));
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

function composeLayers(
  orderedLayers: OrderedLayerRecord[],
  deckPropsLayers: LayersList = [],
  scaleBarLayer?: Layer,
  layerOrder?: string[]
): LayersList {
  const layers: LayersList = sortLayerRecords(orderedLayers, layerOrder);

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

function getScaleBarLoader(vivLayerProps: ImageLayerConfig[]): VivLoader[] | undefined {
  for (const layerProps of vivLayerProps) {
    const loader = layerProps.loader;
    if (Array.isArray(loader) && loader[0]?.meta?.physicalSizes?.x) {
      return loader as VivLoader[];
    }
  }
  return undefined;
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
    const firstLayerWithLoader = this.props.vivLayerProps.find((layerProps) => layerProps.loader);

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

  private getScaleBarView(): ScaleBarView | undefined {
    const loader = getScaleBarLoader(this.props.vivLayerProps);
    if (!loader) {
      return undefined;
    }
    return new ScaleBarView({
      id: this.scaleBarViewId,
      width: this.props.width,
      height: this.props.height,
      loader,
      snap: true,
      imageViewId: this.viewId,
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

  layerFilter({ layer, viewport }: { layer: Layer; viewport: any }): boolean {
    return layer.id.includes(getVivId(viewport.id));
  }

  _onViewStateChange({
    viewId,
    viewState,
  }: { viewId: string; viewState: VivViewState }): VivViewState {
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
    const { vivLayerProps, extraLayers, layerOrder, deckProps, onHover } = this.props;
    const { viewStates } = this.state;

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

    if (vivLayerProps.length === 0) {
      return composeLayers(extraLayerRecords, deckPropsLayersWithVivId, undefined, layerOrder);
    }

    const orderedLayers: OrderedLayerRecord[] = [...extraLayerRecords];
    let scaleBarLayer: Layer | undefined;
    const scaleBarView = this.getScaleBarView();

    for (const imageLayerProps of vivLayerProps) {
      const layerProps: Record<string, unknown> = {
        loader: imageLayerProps.loader,
        colors: imageLayerProps.colors,
        contrastLimits: imageLayerProps.contrastLimits,
        channelsVisible: imageLayerProps.channelsVisible,
        selections: imageLayerProps.selections,
        onHover,
      };

      // Let Viv/deck merge these with layer defaultProps (including `extensions`).
      // Do not patch `layer.props` afterward with `{ ...layer.props, opacity }` — that spread
      // drops non-enumerable props like `extensions` and breaks MultiscaleImageLayer._update.
      if (imageLayerProps.opacity !== undefined) {
        layerProps.opacity = imageLayerProps.opacity;
      }
      if (imageLayerProps.visible !== undefined) {
        layerProps.visible = imageLayerProps.visible;
      }
      if (imageLayerProps.modelMatrix) {
        layerProps.modelMatrix = imageLayerProps.modelMatrix;
      }

      const vivLayersResult = this.detailView.getLayers({
        props: layerProps,
      });

      const layersForImage = normalizeVivLayers(vivLayersResult);

      for (const layer of layersForImage) {
        if (layer instanceof ScaleBarLayer) {
          if (!scaleBarLayer) {
            scaleBarLayer = layer;
          }
          continue;
        }

        // Viv uses generic source-based ids here, so overlays need a stable per-image suffix.
        orderedLayers.push({
          layer: layer.clone({ id: `${layer.id}-${imageLayerProps.id}` }),
          orderId: imageLayerProps.id,
        });
      }
    }

    if (!scaleBarLayer && scaleBarView) {
      const scaleBarLayers = normalizeVivLayers(
        scaleBarView.getLayers({
          viewStates,
        })
      );
      scaleBarLayer = scaleBarLayers.find((layer) => layer instanceof ScaleBarLayer);
    }

    return composeLayers(orderedLayers, deckPropsLayersWithVivId, scaleBarLayer, layerOrder);
  }

  render() {
    const { width, height, onHover, onClick, deckProps } = this.props;
    const { viewStates } = this.state;

    if (width <= 0 || height <= 0) {
      return null;
    }

    const layers = this._renderLayers();
    const scaleBarView = this.getScaleBarView();
    const deckGLViews = scaleBarView
      ? [this.detailView.getDeckGlView(), scaleBarView.getDeckGlView()]
      : this.detailView.getDeckGlView();

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
        style={{ backgroundColor: '#111', ...deckProps?.style }}
      />
    );
  }
}

export { VivSpatialViewer };
export default VivSpatialViewer;
