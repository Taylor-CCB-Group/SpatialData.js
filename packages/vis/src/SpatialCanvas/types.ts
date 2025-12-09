/**
 * Types for SpatialCanvas - framework-agnostic where possible
 */

import type { Matrix4 } from '@math.gl/core';
import type { SpatialElement, AnyElement } from '@spatialdata/core';

// ============================================
// View State Types
// ============================================

export interface ViewState {
  target: [number, number] | [number, number, number];
  zoom: number;
  // Future: rotation, bearing, pitch for 3D
}

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
}

export interface ImageLayerConfig extends BaseLayerConfig {
  type: 'image';
  elementKey: string;
  // Image-specific settings can go here (channels, contrast, etc.)
}

export interface ShapesLayerConfig extends BaseLayerConfig {
  type: 'shapes';
  elementKey: string;
  // Shapes-specific settings
  fillColor?: [number, number, number, number];
  strokeColor?: [number, number, number, number];
  strokeWidth?: number;
}

export interface PointsLayerConfig extends BaseLayerConfig {
  type: 'points';
  elementKey: string;
  // Points-specific settings
  pointSize?: number;
  color?: [number, number, number, number];
}

export interface LabelsLayerConfig extends BaseLayerConfig {
  type: 'labels';
  elementKey: string;
  // Labels-specific settings (colormap, etc.)
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
  
  /** Set loading state */
  setLoading: (loading: boolean) => void;
  
  /** Reset to initial state */
  reset: () => void;
}

export type SpatialCanvasStore = SpatialCanvasState & SpatialCanvasActions;

