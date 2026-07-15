/**
 * Channel defaults for Viv image and labels loaders.
 *
 * The two `build*ChannelDefaults` functions at the bottom were **inline in
 * `useLayerData`'s load effect** — ~180 lines braided into the middle of a
 * kind-switch. They are lifted here **verbatim**, not rewritten: they now run in
 * `ImagesResolver.load()` / `LabelsResolver.load()` instead of inside a React hook.
 *
 * They stay in `@spatialdata/vis` and are *not* moved to `core`. `avivatorish`
 * imports React **and** Viv, and it is a de-vendoring holding pen for code that
 * also lives upstream in Viv and in MDV — its own README calls the serialized image
 * state model "still evolving". Shaping `core` around it, or inventing a port to
 * hide it behind, would freeze a guess about an unsettled model into the package
 * `tgpu-htj2k` depends on. See ADR 0004's amendment.
 */

import {
  buildDefaultSelection,
  COLOR_PALLETE,
  clampVivSelectionsToAxes,
  getMultiSelectionStats,
  getVivSelectionAxisSizes,
  guessRgb,
  isInterleaved,
  tryParseOmeroHexColor,
} from '@spatialdata/avivatorish';
import type { ImageElement, LabelsElement } from '@spatialdata/core';

/** Loader fields used for channel count and contrast range heuristics. */
export type VivLoaderMetadata = {
  labels: string[];
  shape: number[];
  dtype?: string;
  bitDepth?: number;
};

/** Fields on image loader state that this module sets (mirrors ImageLoaderData channel props). */
export interface ImageLoaderChannelTarget {
  contrastLimits?: [number, number][];
  colors?: [number, number, number][];
  channelsVisible?: boolean[];
  selections?: Array<Partial<{ z: number; c: number; t: number }>>;
  selectionAxisSizes?: Partial<Record<'z' | 'c' | 't', number>>;
}

/** Upper bound for contrast when dtype/bitDepth are unknown or floating-point. */
export function maxValueFromLoaderMetadata(loaderObj: {
  dtype?: string;
  bitDepth?: number;
}): number {
  if (
    typeof loaderObj.bitDepth === 'number' &&
    loaderObj.bitDepth > 0 &&
    Number.isFinite(loaderObj.bitDepth)
  ) {
    return 2 ** Math.floor(loaderObj.bitDepth) - 1;
  }
  const dt = (loaderObj.dtype ?? '').toLowerCase();
  if (dt.includes('uint8') || dt.endsWith('u1')) return 255;
  if (dt.includes('uint16') || dt.endsWith('u2')) return 65535;
  if (dt.includes('uint32') || dt.endsWith('u4')) return 4294967295;
  if (dt.includes('float')) return 1;
  return 65535;
}

export function channelCountFromLoader(
  loaderObj: { labels: string[]; shape: number[] },
  selectionAxisSizes: Partial<Record<'z' | 'c' | 't', number>> | undefined
): number {
  const c = selectionAxisSizes?.c;
  if (typeof c === 'number' && c > 0) return c;
  const ci = loaderObj.labels.findIndex((l) => l.toLowerCase() === 'c');
  if (ci >= 0 && typeof loaderObj.shape[ci] === 'number' && loaderObj.shape[ci] > 0) {
    return loaderObj.shape[ci];
  }
  const s2 = loaderObj.shape[2];
  if (typeof s2 === 'number' && s2 > 0) return s2;
  const len = loaderObj.labels?.length;
  if (typeof len === 'number' && len > 0) return len;
  return 1;
}

/**
 * Per-channel contrast/colors/visibility and Viv selections when Omero has no channel list.
 */
export function applyPerChannelFallbackWithoutOmero(
  imageData: ImageLoaderChannelTarget,
  loaderObj: VivLoaderMetadata,
  selections: Array<Partial<{ z: number; c: number; t: number }>>
): void {
  const axisSizes =
    imageData.selectionAxisSizes ?? getVivSelectionAxisSizes(loaderObj.labels, loaderObj.shape);
  const channelCount = channelCountFromLoader(loaderObj, axisSizes);
  const maxValue = maxValueFromLoaderMetadata(loaderObj);
  imageData.contrastLimits = Array.from(
    { length: channelCount },
    () => [0, maxValue] as [number, number]
  );
  imageData.colors =
    channelCount === 1
      ? [[255, 255, 255] as [number, number, number]]
      : Array.from(
          { length: channelCount },
          (_, i) => COLOR_PALLETE[i % COLOR_PALLETE.length] as [number, number, number]
        );
  imageData.channelsVisible = Array(channelCount).fill(true);
  imageData.selections = selections;
}

/** Shape of the resolved image data. Mirrors `ImageLoaderData` in `useLayerData`. */
export interface ImageChannelDefaults extends ImageLoaderChannelTarget {
  loader: unknown;
  channelNames?: string[];
}

/** Shape of the resolved labels data. Mirrors `LabelsLoaderData` in `useLayerData`. */
export interface LabelsChannelDefaults extends ImageLoaderChannelTarget {
  loader: unknown;
  channelOpacities?: number[];
  channelOutlineOpacities?: number[];
  channelsFilled?: boolean[];
  channelStrokeWidths?: number[];
}

const hasVivMetadata = (loader: unknown): loader is VivLoaderMetadata =>
  !!loader && typeof loader === 'object' && 'labels' in loader && 'shape' in loader;

/** The last-resort defaults, used when the loader tells us nothing at all. */
const applyBlindDefaults = (target: ImageLoaderChannelTarget): void => {
  target.contrastLimits = [[0, 65535]];
  target.colors = [[255, 255, 255]];
  target.channelsVisible = [true];
  target.selections = [{}];
};

/**
 * Channel defaults for an image: Omero metadata when present, RGB heuristics when
 * it looks like RGB, computed contrast stats otherwise, per-channel fallback when
 * Omero has no channel list, and blind defaults when the loader exposes no
 * labels/shape at all.
 *
 * Lifted verbatim from `useLayerData`'s image branch. The nested try/catch is
 * deliberate and preserved: computing stats reads pixels, which can fail on a
 * store that served its metadata perfectly well — and a channel-defaults failure
 * must degrade to a fallback, not fail the image.
 */
export async function buildImageChannelDefaults(
  loader: unknown,
  element: ImageElement,
  onNotice?: (reason: string) => void
): Promise<ImageChannelDefaults> {
  const loaderToCheck = Array.isArray(loader) ? loader[0] : loader;
  const imageData: ImageChannelDefaults = { loader };

  try {
    if (hasVivMetadata(loaderToCheck)) {
      const loaderObj = loaderToCheck;
      imageData.selectionAxisSizes = getVivSelectionAxisSizes(loaderObj.labels, loaderObj.shape);

      const selections = buildDefaultSelection({
        labels: loaderObj.labels,
        shape: loaderObj.shape,
      });
      const metadata = element.attrs.omero;

      if (metadata?.channels) {
        const Channels = metadata.channels;
        imageData.channelNames = Channels.map(
          (c: { label?: string }, i: number) => c.label ?? `Channel ${i + 1}`
        );
        const isRgb = guessRgb({
          Pixels: { Channels: Channels.map((c: { label?: string }) => ({ Name: c.label })) },
        });

        if (isRgb) {
          if (isInterleaved(loaderObj.shape)) {
            imageData.contrastLimits = [[0, 255]];
            imageData.colors = [[255, 0, 0]];
          } else {
            imageData.contrastLimits = [
              [0, 255],
              [0, 255],
              [0, 255],
            ];
            imageData.colors = [
              [255, 0, 0],
              [0, 255, 0],
              [0, 0, 255],
            ];
          }
          imageData.channelsVisible = imageData.colors.map(() => true);
        } else {
          const stats = await getMultiSelectionStats({ loader, selections, use3d: false });
          imageData.contrastLimits = stats.contrastLimits;
          const computedColors: [number, number, number][] =
            stats.contrastLimits.length === 1
              ? [[255, 255, 255]]
              : stats.contrastLimits.map((_, i): [number, number, number] => {
                  const rgb = tryParseOmeroHexColor(Channels[i]?.color);
                  const p = COLOR_PALLETE[i % COLOR_PALLETE.length];
                  return rgb ?? [p[0], p[1], p[2]];
                });
          imageData.colors = computedColors;
          imageData.channelsVisible = computedColors.map(() => true);
        }
        imageData.selections = selections;
      } else {
        applyPerChannelFallbackWithoutOmero(imageData, loaderObj, selections);
      }
    } else {
      applyBlindDefaults(imageData);
    }
  } catch (error) {
    // Healthy imagery whose channel defaults could not be computed is NOT a failed
    // image — it draws with fallback channels. That distinction is why EntryNotice
    // exists as a channel separate from SpatialEntryError.
    onNotice?.(error instanceof Error ? error.message : String(error));
    if (hasVivMetadata(loaderToCheck)) {
      try {
        imageData.selectionAxisSizes =
          imageData.selectionAxisSizes ??
          getVivSelectionAxisSizes(loaderToCheck.labels, loaderToCheck.shape);
        const fallbackSelections = buildDefaultSelection({
          labels: loaderToCheck.labels,
          shape: loaderToCheck.shape,
        });
        applyPerChannelFallbackWithoutOmero(imageData, loaderToCheck, fallbackSelections);
      } catch {
        applyBlindDefaults(imageData);
      }
    } else {
      applyBlindDefaults(imageData);
    }
  }

  return imageData;
}

/**
 * Channel defaults for a labels element: one channel, semi-transparent fill with a
 * strong outline. Lifted verbatim from `useLayerData`'s labels branch.
 *
 * Note labels carry SEVEN channel arrays where images carry four — which is why
 * `avivatorish`'s `mergeLayerChannelState` does not cover them and the ladder is
 * hand-written in two places today.
 */
export function buildLabelsChannelDefaults(
  loader: unknown,
  element: LabelsElement
): LabelsChannelDefaults {
  const loaderToCheck = Array.isArray(loader) ? loader[0] : loader;
  const labelsData: LabelsChannelDefaults = {
    loader,
    colors: [[255, 255, 255]],
    channelsVisible: [true],
    channelOpacities: [0.18],
    channelOutlineOpacities: [0.95],
    channelsFilled: [true],
    channelStrokeWidths: [1.5],
    selections: [{}],
  };

  if (hasVivMetadata(loaderToCheck)) {
    const axisSizes = getVivSelectionAxisSizes(loaderToCheck.labels, loaderToCheck.shape);
    const selections = clampVivSelectionsToAxes(
      buildDefaultSelection({ labels: loaderToCheck.labels, shape: loaderToCheck.shape }),
      axisSizes
    ).slice(0, 1);
    const metadataChannels = element.attrs.omero?.channels;

    const rgb = tryParseOmeroHexColor(metadataChannels?.[0]?.color);
    const palette = COLOR_PALLETE[0];
    const color: [number, number, number] = rgb ?? [palette[0], palette[1], palette[2]];

    labelsData.selectionAxisSizes = axisSizes;
    labelsData.selections = selections.length > 0 ? selections : [{}];
    labelsData.colors = [color];
    labelsData.channelsVisible = [metadataChannels?.[0]?.active ?? true];
    labelsData.channelOpacities = [0.18];
    labelsData.channelOutlineOpacities = [0.95];
    labelsData.channelsFilled = [true];
    labelsData.channelStrokeWidths = [1.5];
  }

  return labelsData;
}
