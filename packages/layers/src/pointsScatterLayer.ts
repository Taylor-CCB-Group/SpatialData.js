import type { Matrix4 } from '@math.gl/core';
import { ScatterplotLayer } from 'deck.gl';
import type { FeatureColorOverrides } from './pointsFeatureColor.js';
import { PointsFeatureColorExtension } from './pointsFeatureColorExtension.js';
import type { ColumnarNdarrayPointsBatch } from './pointsLoader.js';
import { buildPointsAttributes, buildPointsDeckData } from './pointsRenderAttributes.js';

/** Orthographic zoom at which configured pointSize applies at full scale. */
export const POINT_SIZE_ZOOM_REFERENCE = 0;
/** Minimum radius multiplier when zoomed out (reduces fragment overdraw). */
export const MIN_POINT_SIZE_SCALE = 0.15;
export const DEFAULT_POINT_SIZE = 0.1;
export const DEFAULT_POINT_RADIUS_MIN_PIXELS = 0.01;
export const DEFAULT_POINT_RADIUS_MAX_PIXELS = 3;

/**
 * The uniform scale factor a model matrix applies to positions.
 *
 * Deck runs `modelMatrix` over POSITIONS but not over a `'common'`-unit radius, so
 * the two disagree by exactly this factor. A SpatialData element's transform is
 * whatever the writer chose — a Xenium element may scale by 4.7, while an element
 * expressed in millimetres scales by 0.00012 — and without correction the same
 * `pointSize` renders ~40000x differently between those two.
 *
 * Returns the geometric mean of the x and y basis lengths, so a mildly anisotropic
 * transform gets a sensible single radius; 1 for a missing or degenerate matrix,
 * which leaves sizing exactly as it was.
 */
export function modelMatrixUniformScale(matrix: Matrix4 | null | undefined): number {
  if (!matrix) {
    return 1;
  }
  // Column-major: column 0 is the x basis, column 1 the y basis.
  const m = matrix as unknown as ArrayLike<number>;
  if (typeof m[0] !== 'number') {
    return 1;
  }
  const scaleX = Math.hypot(m[0] ?? 0, m[1] ?? 0, m[2] ?? 0);
  const scaleY = Math.hypot(m[4] ?? 0, m[5] ?? 0, m[6] ?? 0);
  const scale = Math.sqrt(scaleX * scaleY);
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

export function zoomScaledPointSize(
  pointSize: number,
  zoom: number | null | undefined,
  zoomReference = POINT_SIZE_ZOOM_REFERENCE,
  minScale = MIN_POINT_SIZE_SCALE
): number {
  if (zoom === null || zoom === undefined || !Number.isFinite(zoom)) {
    return pointSize;
  }
  const scale = 2 ** (zoom - zoomReference);
  return pointSize * Math.min(1, Math.max(minScale, scale));
}

export interface PointsScatterStyleProps {
  color: [number, number, number, number];
  pointSize: number;
  pointRadiusMinPixels?: number;
  pointRadiusMaxPixels?: number;
  pointMinSizeScale?: number;
  viewZoom?: number | null;
  opacity: number;
  modelMatrix: Matrix4;
  use3d?: boolean;
  tileBounds?: [number, number, number, number];
  tileSubLayer?: boolean;
  /** Colour points by their per-point feature code (requires batch codes). */
  colorByFeature?: boolean;
  /** Number of feature codes the colour LUT must cover (catalog `maxCode + 1`). */
  featureCodeSpaceSize?: number;
  /** Per-feature colour overrides (`code → [r,g,b]`); absent codes keep the default. */
  featureColorOverrides?: FeatureColorOverrides | null;
  /** Emphasise one feature code (others desaturate + dim); -1 highlights nothing. */
  highlightFeatureCode?: number;
}

// One shared extension instance: it is stateless, so every scatter layer that
// opts into colour-by-feature can reuse it (deck keys shader compilation by the
// extension's identity + props).
const pointsFeatureColorExtension = new PointsFeatureColorExtension();

export function renderColumnarScatterLayer(
  id: string,
  batch: ColumnarNdarrayPointsBatch,
  props: PointsScatterStyleProps
) {
  // Preloaded scatter sizes points in WORLD (common) units so the GPU scales
  // them with zoom — points shrink when you zoom out, which is exactly where
  // scatter overdraw is worst — while `radiusMinPixels`/`radiusMaxPixels` clamp
  // the projected radius so points never vanish or bloat. The Morton tile path
  // keeps fixed pixel sizing (tiles are already viewport-bounded).
  const isTile = props.tileSubLayer === true;
  const radiusUnits: 'common' | 'pixels' = isTile ? 'pixels' : 'common';
  const radiusMinPixels = props.pointRadiusMinPixels ?? DEFAULT_POINT_RADIUS_MIN_PIXELS;
  const radiusMaxPixels = props.pointRadiusMaxPixels ?? DEFAULT_POINT_RADIUS_MAX_PIXELS;
  // `pointSize` means "this many units of the ELEMENT's own coordinate space".
  // Deck transforms positions by `modelMatrix` but leaves a common-unit radius
  // alone, so without folding the matrix scale in here the same pointSize renders
  // wildly differently per element: an element with a 0.00012 mm affine drew points
  // ~8000x too large for its data, swamping the view and shredding fill rate.
  // Pixel-unit tiles are already viewport-relative and must not be rescaled.
  const transformScale = isTile ? 1 : modelMatrixUniformScale(props.modelMatrix);

  // Feed deck GPU-ready binary attributes (interleaved positions) instead of a
  // per-object `getPosition` closure. The buffer is memoized on the batch, so a
  // stable batch hands deck the same array every render (no re-upload).
  const attributes = buildPointsAttributes(batch, props.use3d === true);

  // Colour-by-feature rides an extra `getFeatureCode` binary attribute consumed
  // by the shader extension. Only wire it when codes are present; the extension
  // gates on an `enabled` uniform so toggling colour is a uniform swap, not a
  // re-batch. Kept off the Morton tile path (tiles carry no codes yet).
  // The colour extension is attached to EVERY scatter layer (see the extension
  // docs: deck only runs an extension's initializeState at first mount, so
  // attaching lazily would never register the attribute). Colour is gated by the
  // buffer: supply the per-point codes only when colour-by-feature is on and the
  // batch has them; otherwise the attribute reads its -1 default and the shader
  // leaves the flat fill colour alone. Buffer is keyed by the accessor name.
  // Colour-by-feature is on by default (opt-out via colorByFeature: false) and
  // applies whenever the batch carries codes. Future customisation (palettes,
  // highlight modes) will hang off richer config.
  const colorByFeature = props.colorByFeature !== false && attributes.featureCodes !== undefined;

  return new ScatterplotLayer({
    id,
    coordinateSystem: 'cartesian',
    // Memoized per (batch, use3d, colorByFeature): deck compares `data` by
    // IDENTITY, so a fresh wrapper — even around identical buffers — invalidates
    // every attribute and re-uploads the whole position buffer.
    data: buildPointsDeckData(batch, props.use3d === true, colorByFeature),
    ...(props.tileBounds ? { bounds: props.tileBounds } : {}),
    extensions: [pointsFeatureColorExtension],
    // Sizes the colour LUT texture and supplies any per-feature overrides — read by
    // the extension to (re)build `pfcPalette`.
    featureCodeSpaceSize: props.featureCodeSpaceSize ?? 0,
    ...(props.featureColorOverrides ? { featureColorOverrides: props.featureColorOverrides } : {}),
    highlightFeatureCode: props.highlightFeatureCode ?? -1,
    // Constant default: the binary getFeatureCode attribute overrides it when
    // colouring; when it is withdrawn (colour off), deck reverts to this -1, so
    // the shader's `featureCode >= 0.0` guard falls through to the flat colour.
    getFeatureCode: -1,
    // getRadius: props.pointSize,
    radiusScale: props.pointSize * transformScale,
    radiusUnits,
    radiusMinPixels,
    radiusMaxPixels,
    getFillColor: props.color,
    opacity: props.opacity,
    modelMatrix: props.modelMatrix,
    pickable: true,
    autoHighlight: true,
    highlightColor: [255, 255, 0, 200],
    // updateTriggers: {
    //   radiusScale: [props.pointSize],
    // },
  });
}
