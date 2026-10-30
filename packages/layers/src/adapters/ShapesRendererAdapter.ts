import type { Layer } from '@deck.gl/core';
import type { Matrix4 } from '@math.gl/core';
import type { AssociatedTableFeatureRows, ShapesRenderData } from '@spatialdata/core';
import {
  type FeatureColorBuffer,
  type FeatureColorScheme,
  featureColorSchemeSignature,
} from '../featureColorEncoding.js';
import { buildShapeFillColorByFeatureId, type ShapeFillColorMode } from '../shapeColorEncoding.js';
import {
  buildShapeFeatureStateRuntime,
  buildShapesPrebuiltData,
  createShapesDeckLayer,
  DEFAULT_SHAPE_FILL_COLOR,
  DEFAULT_SHAPE_STROKE_WIDTH,
  DEFAULT_SHAPE_STROKE_WIDTH_MAX_PIXELS,
  DEFAULT_SHAPE_STROKE_WIDTH_MIN_PIXELS,
  DEFAULT_SHAPE_STROKE_WIDTH_UNITS,
  EMPTY_SHAPE_FEATURE_STATE_RUNTIME,
  type ShapeFeatureStateRuntime,
  type ShapeStrokeWidthUnits,
  type ShapesPrebuiltData,
} from '../shapesLayer.js';

/**
 * The deck Renderer Adapter for shapes: ADR 0004 §4’s `project()` and `render()`.
 *
 * `ShapesResolver` (`core`) owns the data — geometry, tooltip metadata, fill-colour rows,
 * each resolved independently. This owns the identity the renderer needs. deck tears a
 * layer down when its `data` identity changes and `getLayers()` runs on every render, so
 * each projection below is memoised on its source’s identity rather than rebuilt per call.
 */

/**
 * A column plus how to encode it, as the adapter reads it off a layer config. Declared
 * structurally rather than imported from `@spatialdata/vis`, which would be a dependency
 * cycle; `FillColorByColumn<ShapeFillColorMode>` there satisfies it.
 */
export interface ShapesFillColorColumnSpec extends FeatureColorScheme {
  columnName: string;
  mode: ShapeFillColorMode;
}

/** Per-feature filtering and colouring, as the adapter reads it off a layer config. */
export interface ShapesProjectionFeatureState {
  fillColorByFeatureId?: Record<string, [number, number, number, number]>;
  strokeColorByFeatureId?: Record<string, [number, number, number, number]>;
  hiddenFeatureIds?: string[];
  fadedFeatureIds?: string[];
  filteredOpacityMultiplier?: number;
}

/**
 * The entry props the adapter reads, so the seam states exactly what rendering a shapes
 * entry depends on. `ShapesLayerConfig` in `@spatialdata/vis` satisfies it structurally.
 */
export interface ShapesEntryProps {
  visible?: boolean;
  opacity?: number;
  fillColor?: [number, number, number, number];
  fillColorByColumn?: ShapesFillColorColumnSpec;
  strokeColor?: [number, number, number, number];
  strokeWidth?: number;
  strokeWidthUnits?: ShapeStrokeWidthUnits;
  strokeWidthMinPixels?: number;
  strokeWidthMaxPixels?: number;
  featureState?: ShapesProjectionFeatureState;
}

/** Resolved resources plus entry props — one shapes entry's whole render input. */
export interface ShapesRenderInput {
  layerId: string;
  elementKey: string;
  props: ShapesEntryProps;
  /** The merged geometry, from {@link ShapesRendererAdapter.getRenderData}. */
  renderData: ShapesRenderData;
  /** The resolver's fill-colour table rows for this layer's column, if any. */
  fillColorRows: AssociatedTableFeatureRows | undefined;
  modelMatrix: Matrix4;
  /**
   * Host-computed per-feature RGBA indexed by feature index. Wins over
   * `featureState` for fill colour — see `CreateShapesDeckLayerOptions.featureColors`.
   */
  featureColors?: FeatureColorBuffer;
  /**
   * When false, render non-pickable (autoHighlight + hover picking off), so deck stops
   * re-rasterising geometry into the picking buffer while the camera moves. Default true.
   */
  pickingEnabled?: boolean;
}

export interface ShapeFillColorEntry {
  fillColorByFeatureId: Record<string, [number, number, number, number]>;
  signature: string;
  /** The resolver fill-colour rows this map was built from. Rebuild on identity change. */
  rowsSource?: unknown;
  /** The render data this map was built from. Rebuild on identity change. */
  renderSource?: ShapesRenderData;
  /**
   * The element these colours were built against. Feature ids are unique only within an
   * element, so an entry is re-served as last-good only while the layer still points at
   * the same one.
   */
  elementKey?: string;
}

interface ShapePrebuiltEntry {
  prebuilt: ShapesPrebuiltData;
  /** Serialised, sorted `hiddenFeatureIds` — used to detect when a rebuild is needed. */
  signature: string;
  /** The (merged) render data this prebuilt was built from. Rebuild on identity change. */
  source: ShapesRenderData;
}

interface FeatureStateEntry {
  signature: string;
  runtime: ShapeFeatureStateRuntime;
  fillColorEntry: ShapeFillColorEntry | undefined;
}

interface MergedRenderDataEntry {
  raw: ShapesRenderData;
  tooltipRowIndices: Int32Array | undefined;
  merged: ShapesRenderData;
}

/** Alpha for table-derived fills: a shapes layer's fill alpha is its only opacity control. */
export function shapeFillColorAlpha(config: ShapesEntryProps): number {
  return config.fillColor?.[3] ?? 180;
}

/** Stable serialisation of `hiddenFeatureIds` for cache-invalidation comparison. */
export function serializeHiddenIds(ids?: string[]): string {
  if (!ids || ids.length === 0) return '';
  return ids.slice().sort().join('\x00');
}

function serializeColorByFeatureId(
  colors?: Record<string, readonly [number, number, number, number]>
): string {
  if (!colors || Object.keys(colors).length === 0) return '';
  const entries = Object.entries(colors).sort(([a], [b]) => a.localeCompare(b));
  return `\x02${entries.length}:${JSON.stringify(entries)}`;
}

function fillColorSignature(config: ShapesEntryProps): string {
  const fillColorByColumn = config.fillColorByColumn;
  if (!fillColorByColumn?.columnName) return '';
  // The scheme is part of the key: swapping a palette changes every colour without
  // touching the column, so a column-only key would keep serving the old colours.
  return [
    fillColorByColumn.columnName,
    fillColorByColumn.mode,
    String(shapeFillColorAlpha(config)),
    featureColorSchemeSignature(fillColorByColumn),
  ].join('\u0001');
}

function mergeFeatureStateForRender(
  config: ShapesEntryProps,
  fillColorEntry: ShapeFillColorEntry | undefined
): ShapesProjectionFeatureState | undefined {
  if (!config.fillColorByColumn?.columnName) {
    return config.featureState;
  }
  // A column is selected but its rows have not landed, and there is no last-good entry to
  // fall back on. Leave the caller’s feature-state alone: writing an empty map here clears
  // what is drawn for the whole load window, flashing the layer back to its flat fill.
  if (!fillColorEntry) {
    return config.featureState;
  }
  return {
    ...config.featureState,
    fillColorByFeatureId: fillColorEntry.fillColorByFeatureId,
    // The outline is not pre-mirrored from the fill: `deriveStrokeColor` lightens each
    // feature’s resolved fill at render time, so a same-colour outline would be invisible.
    // A caller’s explicit per-feature stroke (carried by the spread above) still wins.
  };
}

function featureStateSignature(
  config: ShapesEntryProps,
  fillColorEntry: ShapeFillColorEntry | undefined
): string {
  const featureState = config.featureState;
  return [
    serializeHiddenIds(featureState?.hiddenFeatureIds),
    serializeHiddenIds(featureState?.fadedFeatureIds),
    String(featureState?.filteredOpacityMultiplier ?? ''),
    fillColorEntry?.signature ?? '',
    serializeColorByFeatureId(featureState?.fillColorByFeatureId),
    serializeColorByFeatureId(featureState?.strokeColorByFeatureId),
  ].join('\x01');
}

/**
 * Caches live for the adapter’s lifetime, which the owner chooses. They are safe to
 * outlive a dataset swap: every memo keys on its source object’s identity, and a swap
 * replaces those sources, so only unused layer ids’ memory is retained — which
 * {@link evictLayer} reclaims.
 */
export class ShapesRendererAdapter {
  /** Keyed by element key — see {@link getRenderData}. */
  private readonly mergedRenderData = new Map<string, MergedRenderDataEntry>();
  private readonly prebuilt = new Map<string, ShapePrebuiltEntry>();
  /**
   * Keyed by layer id, not element key: two layers may render the same shapes through
   * different table columns.
   */
  private readonly fillColors = new Map<string, ShapeFillColorEntry>();
  private readonly featureStates = new Map<string, FeatureStateEntry>();

  /**
   * The geometry a shapes layer renders: the resolver’s raw render data with
   * `rowIndexByFeatureIndex` overwritten by the tooltip resource’s indices.
   *
   * The resolver keeps geometry and tooltip metadata independent — a broken tooltip column
   * must still draw its geometry (ADR 0004 §3) — so the join happens here, memoised on
   * both identities. The raw identity passes through when there is nothing to patch.
   */
  getRenderData(
    elementKey: string,
    raw: ShapesRenderData,
    tooltipRowIndices: Int32Array | undefined
  ): ShapesRenderData {
    const cached = this.mergedRenderData.get(elementKey);
    if (cached && cached.raw === raw && cached.tooltipRowIndices === tooltipRowIndices) {
      return cached.merged;
    }
    const merged = tooltipRowIndices ? { ...raw, rowIndexByFeatureIndex: tooltipRowIndices } : raw;
    this.mergedRenderData.set(elementKey, { raw, tooltipRowIndices, merged });
    return merged;
  }

  /**
   * The pre-filtered per-feature array deck draws from. Rebuilt only when the render data
   * identity or the `hiddenFeatureIds` signature moves — an opacity or colour tweak must
   * not re-run the O(n-features) filter.
   */
  getPrebuilt(
    layerId: string,
    renderData: ShapesRenderData,
    hiddenFeatureIds: string[] | undefined
  ): ShapesPrebuiltData {
    const signature = serializeHiddenIds(hiddenFeatureIds);
    const cached = this.prebuilt.get(layerId);
    if (cached && cached.signature === signature && cached.source === renderData) {
      return cached.prebuilt;
    }
    const prebuilt = buildShapesPrebuiltData(renderData, hiddenFeatureIds);
    this.prebuilt.set(layerId, { prebuilt, signature, source: renderData });
    return prebuilt;
  }

  /**
   * This layer’s table-column fill colours, built from the resolver’s rows.
   *
   * No entry exists until the rows load: the feature-state runtime’s signature has this
   * entry’s presence as its only fill term, so an eager empty entry would suppress the
   * rebuild that makes the colours appear when the rows settle.
   *
   * While rows are pending the previous entry is re-served, so a column switch does not
   * blank the colours already on screen — but only while the element matches, since
   * feature ids are unique only within an element.
   */
  getFillColorEntry(
    layerId: string,
    elementKey: string,
    config: ShapesEntryProps,
    renderData: ShapesRenderData,
    rows: AssociatedTableFeatureRows | undefined
  ): ShapeFillColorEntry | undefined {
    const fillColorByColumn = config.fillColorByColumn;
    if (!fillColorByColumn?.columnName) {
      this.fillColors.delete(layerId);
      return undefined;
    }
    const cached = this.fillColors.get(layerId);
    if (!rows) {
      return cached?.elementKey === elementKey ? cached : undefined;
    }
    const signature = fillColorSignature(config);
    if (
      cached &&
      cached.signature === signature &&
      cached.rowsSource === rows &&
      cached.renderSource === renderData
    ) {
      return cached;
    }
    const entry: ShapeFillColorEntry = {
      signature,
      elementKey,
      fillColorByFeatureId: buildShapeFillColorByFeatureId({
        featureIds: renderData.featureIds,
        rowIndexByFeatureIndex: renderData.rowIndexByFeatureIndex,
        column: rows.extraColumns?.[0],
        mode: fillColorByColumn.mode,
        alpha: shapeFillColorAlpha(config),
        ...(rows.extraColumnKinds?.[0] ? { columnKind: rows.extraColumnKinds[0] } : {}),
        ...(fillColorByColumn.missingValues
          ? { missingValues: fillColorByColumn.missingValues }
          : {}),
        ...(fillColorByColumn.categoricalPalette
          ? { categoricalPalette: fillColorByColumn.categoricalPalette }
          : {}),
        ...(fillColorByColumn.numericRamp ? { numericRamp: fillColorByColumn.numericRamp } : {}),
        ...(fillColorByColumn.numericDomain
          ? { numericDomain: fillColorByColumn.numericDomain }
          : {}),
        ...(fillColorByColumn.numericScale ? { numericScale: fillColorByColumn.numericScale } : {}),
      }),
      rowsSource: rows,
      renderSource: renderData,
    };
    this.fillColors.set(layerId, entry);
    return entry;
  }

  /**
   * The Map/Set feature-state `renderShapesLayer` consumes, with an identity that changes
   * only when its contents do.
   *
   * Keyed on the `fillColorEntry` identity as well as its signature: the signature is
   * column-based, but a column change serves the PREVIOUS column’s rows until the new
   * ones load, so keying on the signature alone leaves the runtime one column behind.
   */
  getFeatureStateRuntime(
    layerId: string,
    config: ShapesEntryProps,
    fillColorEntry: ShapeFillColorEntry | undefined
  ): ShapeFeatureStateRuntime {
    const signature = featureStateSignature(config, fillColorEntry);
    const cached = this.featureStates.get(layerId);
    if (cached?.signature === signature && cached.fillColorEntry === fillColorEntry) {
      return cached.runtime;
    }
    const merged = mergeFeatureStateForRender(config, fillColorEntry);
    const runtime = merged
      ? buildShapeFeatureStateRuntime(merged)
      : EMPTY_SHAPE_FEATURE_STATE_RUNTIME;
    this.featureStates.set(layerId, { signature, runtime, fillColorEntry });
    return runtime;
  }

  /**
   * One shapes entry’s deck output — ADR 0004 §4’s `render()` half. It resolves the
   * projections above itself, so a caller supplies resolved data plus entry props.
   *
   * Returns `[fill, outline]` on the `ScatterplotLayer` path, `null` when hidden.
   */
  render(input: ShapesRenderInput): Layer | Layer[] | null {
    const { layerId, elementKey, props, renderData, fillColorRows, modelMatrix } = input;
    if (props.visible === false) return null;

    const fillColorEntry = this.getFillColorEntry(
      layerId,
      elementKey,
      props,
      renderData,
      fillColorRows
    );

    return createShapesDeckLayer(
      renderData,
      {
        kind: 'shapes',
        elementKey: renderData.elementKey,
        visible: true,
        defaultFillColor: props.fillColor ?? DEFAULT_SHAPE_FILL_COLOR,
        defaultStrokeColor: props.strokeColor,
        defaultStrokeWidth: props.strokeWidth ?? DEFAULT_SHAPE_STROKE_WIDTH,
        defaultStrokeWidthUnits: props.strokeWidthUnits ?? DEFAULT_SHAPE_STROKE_WIDTH_UNITS,
        defaultStrokeWidthMinPixels:
          props.strokeWidthMinPixels ?? DEFAULT_SHAPE_STROKE_WIDTH_MIN_PIXELS,
        defaultStrokeWidthMaxPixels:
          props.strokeWidthMaxPixels ?? DEFAULT_SHAPE_STROKE_WIDTH_MAX_PIXELS,
        featureState: this.getFeatureStateRuntime(layerId, props, fillColorEntry),
      },
      {
        id: layerId,
        visible: true,
        opacity: props.opacity ?? 1,
        modelMatrix,
        ...(input.pickingEnabled !== undefined ? { pickingEnabled: input.pickingEnabled } : {}),
        ...(input.featureColors ? { featureColors: input.featureColors } : {}),
      },
      this.getPrebuilt(layerId, renderData, props.featureState?.hiddenFeatureIds)
    );
  }

  /** Drop the merged-geometry memo for one element, after its resolver entry is evicted. */
  evictElement(elementKey: string): void {
    this.mergedRenderData.delete(elementKey);
  }

  /**
   * Drop every per-layer projection for one layer. All three together deliberately: the
   * feature-state runtime would self-heal, since it keys on the fill-colour entry’s
   * identity, but leaving it behind makes "which of these needs clearing" an invariant
   * someone re-derives at each new eviction site.
   */
  evictLayer(layerId: string): void {
    this.prebuilt.delete(layerId);
    this.fillColors.delete(layerId);
    this.featureStates.delete(layerId);
  }

  dispose(): void {
    this.mergedRenderData.clear();
    this.prebuilt.clear();
    this.fillColors.clear();
    this.featureStates.clear();
  }
}
