/**
 * Types for SpatialCanvas - framework-agnostic where possible
 */

import type { Matrix4 } from '@math.gl/core';
import type { SpatialElement, AnyElement } from '@spatialdata/core';

// ============================================
// View State Types
// ============================================

export type ViewState2D = {
  target: [number, number],
  zoom: number;
}
export type ViewState3D = {
  target: [number, number, number],
  zoom: number,
  // TODO pitch, bearing for 3d.
  // do we really want this type to be different to OrbitViewState from deck?
}
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
  //TODO: how do we pass channel-related extension props?
}

export interface ImageLayerConfig extends BaseLayerConfig {
  type: 'image';
  /** Optional: Advanced channel configuration (for full Viv controls) */
  channels?: ChannelConfig;
}

export interface ShapesLayerConfig extends BaseLayerConfig {
  type: 'shapes';
  // Shapes-specific settings
  // TODO: these should be accessors for getFillColor etc based on picked feature identity
  fillColor?: [number, number, number, number];
  strokeColor?: [number, number, number, number];
  strokeWidth?: number;
  /** Table obs columns to display for a picked feature in this shapes layer. */
  tooltipFields?: string[];
}

export interface PointsLayerConfig extends BaseLayerConfig {
  type: 'points';
  // Points-specific settings
  // TODO: these should be accessors for getColor etc based on e.g. transcript type
  // should be able to filter etc. Some kind of LOD...
  pointSize?: number;
  color?: [number, number, number, number];
}

export interface LabelsLayerConfig extends BaseLayerConfig {
  type: 'labels';
  // Labels-specific settings (colormap, etc.)
  // should also be able to associate with picked feature identity
  // (for example ObjectID-style raster values), so we'll need some kind of
  // buffer lookup for color/filter/etc
}

export type LayerConfig = ImageLayerConfig | ShapesLayerConfig | PointsLayerConfig | LabelsLayerConfig;

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
