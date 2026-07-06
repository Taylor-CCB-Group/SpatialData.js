/**
 * Types for SpatialCanvas - framework-agnostic where possible
 */

import type { Matrix4 } from '@math.gl/core';
import type { AnyElement, SpatialElement } from '@spatialdata/core';
import type {
  ShapeFillColorMode,
  ShapeStrokeWidthUnits,
  ShapesLayerPickEvent,
} from '@spatialdata/layers';

// ============================================
// View State Types
// ============================================

export type ViewState2D = {
  target: [number, number];
  zoom: number;
};
export type ViewState3D = {
  target: [number, number, number];
  zoom: number;
  // TODO pitch, bearing for 3d.
  // do we really want this type to be different to OrbitViewState from deck?
};
export type ViewState = ViewState2D | ViewState3D;

// ============================================
// Layer Configuration Types
// ============================================

export type LayerType = 'image' | 'shapes' | 'points' | 'labels';

export interface BaseLayerConfig {
  /** Unique identifier for the layer */
  id: string;
  /** Whether the layer is visible */
  visible: boolean;
  /** Layer opacity (0-1) */
  opacity: number;
  elementKey: string;
}

export interface ChannelConfig {
  /**
   * Stable id per channel (e.g. for list keys). When omitted, the UI derives
   * ids from the layer id and channel index (pending review if they can be reordered etc).
   */
  channelIds?: string[];
  /** Channel colors as RGB tuples */
  colors?: [number, number, number][];
  /** Contrast limits for each channel [min, max] */
  contrastLimits?: [number, number][];
  /** Visibility for each channel */
  channelsVisible?: boolean[];
  /** Selections for z, c, t dimensions (omit keys for axes that do not exist on the image). */
  selections?: Partial<{ z: number; c: number; t: number }>[];
}

export interface ImageLayerConfig extends BaseLayerConfig {
  type: 'image';
  /** Optional: Advanced channel configuration (for full Viv controls) */
  channels?: ChannelConfig;
  /**
   * Serializable Viv/deck props merged into `detailView.getLayers({ props })`.
   * Host-owned schema for extension state (brightness, contrast, colormap, etc.).
   * See also runtime `vivImageExtensionResolver` / `vivImagePropsResolver` on `SpatialCanvasViewer`.
   */
  vivLayerProps?: Record<string, unknown>;
}

export interface ShapesLayerConfig extends BaseLayerConfig {
  type: 'shapes';
  fillColor?: [number, number, number, number];
  fillColorByColumn?: {
    columnName: string;
    mode: ShapeFillColorMode;
  };
  strokeColor?: [number, number, number, number];
  strokeWidth?: number;
  strokeWidthUnits?: ShapeStrokeWidthUnits;
  strokeWidthMinPixels?: number;
  strokeWidthMaxPixels?: number;
  /** Table obs columns to display for a picked feature in this shapes layer. */
  tooltipFields?: string[];
  featureState?: {
    fillColorByFeatureId?: Record<string, [number, number, number, number]>;
    strokeColorByFeatureId?: Record<string, [number, number, number, number]>;
    hiddenFeatureIds?: string[];
    fadedFeatureIds?: string[];
    filteredOpacityMultiplier?: number;
  };
}

export interface PointsLayerConfig extends BaseLayerConfig {
  type: 'points';
  // Points-specific settings
  // TODO: colour should become an accessor (getColor by Points Feature) — MVP step 3.
  pointSize?: number;
  color?: [number, number, number, number];
  /**
   * Feature-filter selection by Feature Code. `undefined` means "all features
   * shown" (no filter); an array restricts the drawn points to those codes. This
   * is serializable Stack-Entry state (persists in a saved config), distinct from
   * the runtime-only Feature Highlight added in MVP step 3.
   */
  featureCodes?: number[];
}

export interface LabelsLayerConfig extends BaseLayerConfig {
  type: 'labels';
  tooltipFields?: string[];
  channels?: {
    channelIds?: string[];
    colors?: [number, number, number][];
    channelsVisible?: boolean[];
    channelOpacities?: number[];
    channelOutlineOpacities?: number[];
    channelsFilled?: boolean[];
    channelStrokeWidths?: number[];
    selections?: Partial<{ z: number; c: number; t: number }>[];
  };
}

export interface LayerConfigByType {
  image: ImageLayerConfig;
  shapes: ShapesLayerConfig;
  points: PointsLayerConfig;
  labels: LabelsLayerConfig;
}

export type LayerConfig<T extends LayerType = LayerType> = LayerConfigByType[T];

// ============================================
// Element Availability Types
// ============================================

export interface AvailableElement {
  key: string;
  type: LayerType;
  element: SpatialElement;
  /** The transformation matrix to the current coordinate system */
  transform: Matrix4;
}

export interface ElementsByType {
  images: AvailableElement[];
  shapes: AvailableElement[];
  points: AvailableElement[];
  labels: AvailableElement[];
}

export type { ShapesLayerPickEvent };

// ============================================
// Store State Types (framework-agnostic)
// ============================================

export interface SpatialCanvasState {
  /** Currently selected coordinate system */
  coordinateSystem: string | null;

  /** View state (pan/zoom) */
  viewState: ViewState | null;

  /** Layer configurations keyed by layer ID */
  layers: Record<string, LayerConfig>;

  /** Order of layers (bottom to top) */
  layerOrder: string[];

  /** Selected layer for properties / channel UI */
  selectedLayerId: string | null;

  /** Loading state */
  isLoading: boolean;
}

export interface SpatialCanvasActions {
  setCoordinateSystem: (cs: string | null) => void;
  setViewState: (vs: ViewState | null) => void;

  /** Add a layer from an element */
  addLayer: (config: LayerConfig) => void;

  /** Remove a layer by ID */
  removeLayer: (id: string) => void;

  /** Update layer config */
  updateLayer: (id: string, updates: Partial<LayerConfig>) => void;

  /** Toggle layer visibility */
  toggleLayerVisibility: (id: string) => void;

  /** Reorder layers */
  reorderLayers: (newOrder: string[]) => void;

  setSelectedLayerId: (id: string | null) => void;

  /** Set loading state */
  setLoading: (loading: boolean) => void;

  /** Reset to initial state */
  reset: () => void;
}

export type SpatialCanvasStore = SpatialCanvasState & SpatialCanvasActions;
