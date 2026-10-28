import type { Layer } from '@deck.gl/core';
import type { Matrix4 } from '@math.gl/core';
import type { AssociatedTableFeatureRows } from '@spatialdata/core';
import { type FeatureColorScheme, featureColorSchemeSignature } from '../featureColorEncoding.js';
import { LabelsLayer } from '../LabelsLayer.js';
import {
  buildLabelColorLut,
  buildLabelFillColorByFeatureId,
  type LabelColorLut,
  type LabelFeatureState,
  type LabelFillColorMode,
  type LabelRgbaColor,
  type LabelRgbColor,
} from '../labelColorEncoding.js';

/**
 * The deck Renderer Adapter for labels — the labels twin of
 * {@link ShapesRendererAdapter}, and the `project()` half of ADR 0004's phase
 * separation for this kind.
 *
 * A label has no geometry; it *is* a raster pixel value. So where a shapes
 * projection produces a per-feature array, this produces a per-label lookup table
 * indexed by the label's own integer instance id, which the bitmask fragment shader
 * samples.
 *
 * The identity discipline is the whole point. `getLayers()` runs on every render (a
 * hover re-renders for the tooltip) and the LUT can be megabytes for a large
 * segmentation, so `LabelsLayer` decides whether to re-upload its GPU texture by
 * comparing the LUT it is handed **by identity**. A fresh object per render is a
 * texture upload per frame.
 */

/**
 * A column plus how to encode it, as the adapter reads it off a layer config.
 *
 * Declared structurally rather than imported from `@spatialdata/vis`, which would
 * be a dependency cycle. `FillColorByColumn<LabelFillColorMode>` there satisfies
 * this, so a caller passes its config straight through.
 */
export interface LabelsFillColorColumnSpec extends FeatureColorScheme {
  columnName: string;
  mode: LabelFillColorMode;
}

/** Per-channel appearance, as a labels layer config carries it. */
export interface LabelsChannelProps {
  colors?: [number, number, number][];
  channelsVisible?: boolean[];
  channelOpacities?: number[];
  channelOutlineOpacities?: number[];
  channelsFilled?: boolean[];
  channelStrokeWidths?: number[];
}

/**
 * The entry props the adapter reads — not the whole layer config, so the seam
 * states exactly what rendering a labels entry depends on. `LabelsLayerConfig` in
 * `@spatialdata/vis` satisfies it structurally, so a caller passes its config
 * straight through.
 */
export interface LabelsEntryProps {
  visible?: boolean;
  opacity?: number;
  fillColorByColumn?: LabelsFillColorColumnSpec;
  featureState?: LabelFeatureState;
  channels?: LabelsChannelProps;
}

/**
 * The channel defaults the resolver derives from the element's own metadata, which
 * an entry's `channels` override term by term.
 *
 * Declared structurally: `LabelsResolver` lives in `@spatialdata/vis` (ADR 0004's
 * 2026-07-14 amendment keeps it next to its Viv and `avivatorish` dependencies),
 * so importing its result type here would be a cycle.
 */
export type LabelsChannelDefaults = LabelsChannelProps;

/** Resolved resources plus entry props — one labels entry's whole render input. */
export interface LabelsRenderInput {
  layerId: string;
  elementKey: string;
  props: LabelsEntryProps;
  /** The resolver's Viv pixel source for this element. */
  loader: unknown;
  /** The resolver's per-element channel defaults, overridden by `props.channels`. */
  channelDefaults: LabelsChannelDefaults;
  /**
   * The raster selections to draw, already clamped to the element's axes.
   *
   * Resolved by the caller rather than here: the clamp lives in
   * `@spatialdata/avivatorish`, which ADR 0004 treats as a holding pen rather than
   * a stable dependency, and `layers` deliberately does not depend on it.
   */
  selections: Array<Partial<{ z: number; c: number; t: number }>>;
  /** The resolver's fill-colour table rows for this layer's column, if any. */
  fillColorRows: AssociatedTableFeatureRows | undefined;
  modelMatrix: Matrix4;
  /**
   * A host-supplied per-label colour table. Wins outright over the config-driven
   * LUT: it is already the exact table the shader samples, indexed by the raster's
   * own pixel value, so there is nothing to merge and nothing to build.
   */
  featureColors?: LabelColorLut;
  /**
   * The label id under the cursor, or omitted for none.
   *
   * Runtime render state rather than entry config — it changes on every pointer
   * move and must never reach a saved Render Stack. It becomes a shader uniform,
   * so hovering re-uploads neither the LUT nor the tiles.
   */
  highlightedLabelId?: number;
}

/** Rows-derived per-label colours, cached per layer. */
export interface LabelFillColorEntry {
  fillColorByFeatureId: Record<string, LabelRgbaColor>;
  signature: string;
  /** The resolver fill-colour rows this map was built from. Rebuild on identity change. */
  rowsSource?: unknown;
  /**
   * The element these colours were built against. Label ids are only unique within
   * an element (they are small integers, so they collide freely across elements),
   * so a cached entry may be re-served as last-good only while the layer still
   * points at the same element.
   */
  elementKey?: string;
}

interface ColorLutEntry {
  /** `undefined` when the feature-state addresses nothing — draw the plain colour path. */
  lut: LabelColorLut | undefined;
  signature: string;
  fillColorEntry: LabelFillColorEntry | undefined;
}

/**
 * Alpha written into table-derived label colours.
 *
 * Fully opaque on purpose: a labels layer already exposes fill and outline opacity
 * per channel, and the LUT's alpha is a *filter* modulation. Baking a translucent
 * fill in here (as shapes does, where fill alpha is the only opacity control) would
 * silently halve the channel sliders' range.
 */
const LABEL_FILL_COLOR_ALPHA = 255;

/**
 * Last-resort channel defaults, for an element whose resolver supplied none.
 *
 * Single stable references on purpose, for the reason `DEFAULT_SHAPE_FILL_COLOR`
 * gives: these reach deck as props it diffs shallowly, so a fresh literal per
 * render reads as a changed value every frame.
 */
const FALLBACK_CHANNEL_COLORS: [number, number, number][] = [[255, 255, 255]];
const FALLBACK_WHITE: LabelRgbColor = [255, 255, 255];
const FALLBACK_CHANNELS_VISIBLE: boolean[] = [true];
const FALLBACK_CHANNEL_OPACITIES: number[] = [0.18];
const FALLBACK_CHANNEL_OUTLINE_OPACITIES: number[] = [0.95];
const FALLBACK_CHANNELS_FILLED: boolean[] = [true];
const FALLBACK_CHANNEL_STROKE_WIDTHS: number[] = [1.5];

function fillColorSignature(config: LabelsEntryProps): string {
  const fillColorByColumn = config.fillColorByColumn;
  if (!fillColorByColumn?.columnName) return '';
  // The scheme is part of the key: swapping a palette changes every colour without
  // touching the column, so a column-only key would keep serving the old colours.
  return [
    fillColorByColumn.columnName,
    fillColorByColumn.mode,
    featureColorSchemeSignature(fillColorByColumn),
  ].join('');
}

/** Stable serialisation of an id list for cache-invalidation comparison. */
function serializeIds(ids?: string[]): string {
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

/**
 * The feature-state a labels layer actually renders: the caller's own state with
 * the table-column colours merged in. Column colours lose to explicit per-label
 * overrides, matching how a shapes layer resolves the same conflict.
 */
function mergeFeatureStateForRender(
  config: LabelsEntryProps,
  fillColorEntry: LabelFillColorEntry | undefined
): LabelFeatureState | undefined {
  if (!config.fillColorByColumn?.columnName) {
    return config.featureState;
  }
  // A column is selected but its rows have not landed yet (no entry, and no
  // last-good entry to fall back on). Return the caller's feature-state untouched
  // rather than writing an empty map: an empty `fillColorByFeatureId` is a real
  // instruction to the LUT builder, so it clears the colours currently drawn for
  // the whole load window and the labels flash back to their channel colour.
  if (!fillColorEntry) {
    return config.featureState;
  }
  return {
    ...config.featureState,
    fillColorByFeatureId: {
      ...fillColorEntry.fillColorByFeatureId,
      ...config.featureState?.fillColorByFeatureId,
    },
  };
}

function featureStateSignature(
  config: LabelsEntryProps,
  fillColorEntry: LabelFillColorEntry | undefined,
  defaultColor: LabelRgbColor
): string {
  const featureState = config.featureState;
  return [
    serializeIds(featureState?.hiddenFeatureIds),
    serializeIds(featureState?.fadedFeatureIds),
    String(featureState?.filteredOpacityMultiplier ?? ''),
    fillColorEntry?.signature ?? '',
    serializeColorByFeatureId(featureState?.fillColorByFeatureId),
    // The default colour is baked into every unannotated LUT entry, so a channel
    // colour change genuinely invalidates the table.
    defaultColor.join(','),
  ].join('\x01');
}

/**
 * Per-label colours from one obs column, keyed by the label's instance id.
 *
 * Exported for the adapter's own tests: it is the pure half of
 * {@link LabelsRendererAdapter.getFillColorEntry}, with no cache involved.
 */
export function buildLabelFillColorEntry(
  config: LabelsEntryProps,
  rows: AssociatedTableFeatureRows | undefined
): LabelFillColorEntry | undefined {
  const fillColorByColumn = config.fillColorByColumn;
  if (!fillColorByColumn?.columnName || !rows) return undefined;
  return {
    signature: fillColorSignature(config),
    fillColorByFeatureId: buildLabelFillColorByFeatureId({
      rowIds: rows.rowIds,
      rowIndexByFeatureId: rows.rowIndexByFeatureId,
      column: rows.extraColumns?.[0],
      mode: fillColorByColumn.mode,
      alpha: LABEL_FILL_COLOR_ALPHA,
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
  };
}

export class LabelsRendererAdapter {
  /**
   * Per-layer table-column colours, keyed by the label's instance id. Keyed by layer
   * id, not element key: two layers may colour one labels element by different
   * table columns.
   */
  private readonly fillColors = new Map<string, LabelFillColorEntry>();
  private readonly colorLuts = new Map<string, ColorLutEntry>();

  /**
   * This layer's table-column label colours, built from the resolver's rows.
   *
   * Mirrors {@link ShapesRendererAdapter.getFillColorEntry}, including its "no entry
   * until the rows have actually loaded" rule: the LUT is memoised on a signature
   * whose only fill term is this entry, so an eager empty entry would suppress the
   * rebuild that makes the colours appear when the rows settle.
   *
   * Re-serving the previous entry while rows are pending is more load-bearing here
   * than it is for shapes. `LabelsResolver` caches rows per element *and* column
   * with no cross-column stale value, so a plain column switch has a window with no
   * rows at all — and dropping the entry there flashes every label back to its
   * channel colour until the new column settles.
   *
   * The element must match to re-serve: label ids are small integers that collide
   * freely across elements, so another element's entry would colour the wrong labels.
   */
  getFillColorEntry(
    layerId: string,
    elementKey: string,
    config: LabelsEntryProps,
    rows: AssociatedTableFeatureRows | undefined
  ): LabelFillColorEntry | undefined {
    if (!config.fillColorByColumn?.columnName) {
      this.fillColors.delete(layerId);
      return undefined;
    }
    const cached = this.fillColors.get(layerId);
    if (!rows) {
      return cached?.elementKey === elementKey ? cached : undefined;
    }
    const signature = fillColorSignature(config);
    // Both terms are needed: the rows change when the COLUMN changes, and the
    // signature changes when the mode does (same rows, different encoding).
    if (
      cached &&
      cached.elementKey === elementKey &&
      cached.rowsSource === rows &&
      cached.signature === signature
    ) {
      return cached;
    }
    const built = buildLabelFillColorEntry(config, rows);
    if (!built) {
      this.fillColors.delete(layerId);
      return undefined;
    }
    const entry: LabelFillColorEntry = { ...built, elementKey };
    this.fillColors.set(layerId, entry);
    return entry;
  }

  /**
   * The layer's per-label LUT, with an identity that changes only when its contents
   * do — so `LabelsLayer` re-uploads its texture exactly when it must, and never on
   * a bare re-render.
   *
   * The cached entry holds the `fillColorEntry` identity as well as the signature,
   * for the same reason {@link ShapesRendererAdapter.getFeatureStateRuntime} does: a
   * column change serves the PREVIOUS column's rows until the new ones load, so the
   * entry's data can change while its signature does not.
   */
  getColorLut(
    layerId: string,
    config: LabelsEntryProps,
    fillColorEntry: LabelFillColorEntry | undefined,
    defaultColor: LabelRgbColor
  ): LabelColorLut | undefined {
    const signature = featureStateSignature(config, fillColorEntry, defaultColor);
    const cached = this.colorLuts.get(layerId);
    if (cached?.signature === signature && cached.fillColorEntry === fillColorEntry) {
      return cached.lut;
    }
    const merged = mergeFeatureStateForRender(config, fillColorEntry);
    const lut = merged ? buildLabelColorLut({ featureState: merged, defaultColor }) : undefined;
    this.colorLuts.set(layerId, { lut, signature, fillColorEntry });
    return lut;
  }

  /**
   * `render()` — one labels entry's deck output.
   *
   * The other half of ADR 0004 §4. The channel ladder lives here because it is
   * exactly "resolved resources plus entry props": each channel term is the entry's
   * own value when it has one, and the resolver's element-derived default otherwise.
   *
   * Returns `null` for a hidden layer, or one whose loader has not resolved.
   */
  render(input: LabelsRenderInput): Layer | null {
    const { layerId, elementKey, props, loader, channelDefaults, fillColorRows } = input;
    if (props.visible === false || !loader) return null;

    const channels = props.channels;
    // An empty array is not an override — it is a config that has never been
    // touched — so each term falls through to the resolver's default.
    const pick = <T>(own: T[] | undefined, fallback: T[] | undefined, last: T[]): T[] =>
      own && own.length > 0 ? own : (fallback ?? last);

    const channelColors = pick(channels?.colors, channelDefaults.colors, FALLBACK_CHANNEL_COLORS);
    // The default colour is the layer's own channel colour, so a label the
    // feature-state says nothing about draws exactly as it would with the LUT off.
    const featureColorLut =
      input.featureColors ??
      this.getColorLut(
        layerId,
        props,
        this.getFillColorEntry(layerId, elementKey, props, fillColorRows),
        channelColors[0] ?? FALLBACK_WHITE
      );

    return new LabelsLayer({
      id: layerId,
      loader,
      modelMatrix: input.modelMatrix,
      opacity: props.opacity ?? 1,
      visible: true,
      channelColors,
      channelsVisible: pick(
        channels?.channelsVisible,
        channelDefaults.channelsVisible,
        FALLBACK_CHANNELS_VISIBLE
      ),
      channelOpacities: pick(
        channels?.channelOpacities,
        channelDefaults.channelOpacities,
        FALLBACK_CHANNEL_OPACITIES
      ),
      channelOutlineOpacities: pick(
        channels?.channelOutlineOpacities,
        channelDefaults.channelOutlineOpacities,
        FALLBACK_CHANNEL_OUTLINE_OPACITIES
      ),
      channelsFilled: pick(
        channels?.channelsFilled,
        channelDefaults.channelsFilled,
        FALLBACK_CHANNELS_FILLED
      ),
      channelStrokeWidths: pick(
        channels?.channelStrokeWidths,
        channelDefaults.channelStrokeWidths,
        FALLBACK_CHANNEL_STROKE_WIDTHS
      ),
      selections: input.selections,
      ...(featureColorLut ? { featureColorLut } : {}),
      ...(input.highlightedLabelId !== undefined
        ? { highlightedLabelId: input.highlightedLabelId }
        : {}),
    });
  }

  /** Drop every per-layer projection for one layer. */
  evictLayer(layerId: string): void {
    this.fillColors.delete(layerId);
    this.colorLuts.delete(layerId);
  }

  dispose(): void {
    this.fillColors.clear();
    this.colorLuts.clear();
  }
}
