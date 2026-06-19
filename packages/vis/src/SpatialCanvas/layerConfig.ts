import type {
  BaseLayerConfig,
  ImageLayerConfig,
  LabelsLayerConfig,
  LayerConfig,
  LayerType,
  PointsLayerConfig,
  ShapesLayerConfig,
} from './types';

type LayerConfigBase = Pick<BaseLayerConfig, 'id' | 'elementKey' | 'visible' | 'opacity'>;

/**
 * Build a typed {@link LayerConfig} from a layer discriminant and base fields.
 *
 * Required SpatialCanvas fields (`id`, `elementKey`, `visible`, `opacity`) are
 * supplied via `base`. Optional type-specific props may be passed in `props`;
 * values in `base` take precedence over `props` when keys overlap.
 *
 * When `type` is a string literal, the return type narrows to the matching
 * member of {@link LayerConfigByType}. When `type` is a runtime {@link LayerType}
 * union, the return type is the full {@link LayerConfig} union.
 *
 * @param type - Layer discriminant (`'image'`, `'shapes'`, `'points'`, or `'labels'`).
 * @param base - Required layer identity and display fields shared by all layer types.
 * @param props - Optional extension props (for example render-stack or saved UI state).
 */
export function layerConfig(
  type: 'image',
  base: LayerConfigBase,
  props?: Record<string, unknown>
): ImageLayerConfig;
export function layerConfig(
  type: 'shapes',
  base: LayerConfigBase,
  props?: Record<string, unknown>
): ShapesLayerConfig;
export function layerConfig(
  type: 'points',
  base: LayerConfigBase,
  props?: Record<string, unknown>
): PointsLayerConfig;
export function layerConfig(
  type: 'labels',
  base: LayerConfigBase,
  props?: Record<string, unknown>
): LabelsLayerConfig;
export function layerConfig(
  type: LayerType,
  base: LayerConfigBase,
  props?: Record<string, unknown>
): LayerConfig;
export function layerConfig(
  type: LayerType,
  base: LayerConfigBase,
  props: Record<string, unknown> = {}
): LayerConfig {
  return { ...props, ...base, type };
}
