/**
 * Defaults for Viv image loaders when Omero channel metadata is missing or when
 * channel setup fails partway through. Kept separate from useLayerData so the hook stays focused.
 */

import { getVivSelectionAxisSizes, COLOR_PALLETE } from '@spatialdata/avivatorish';

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
  selectionAxisSizes: Partial<Record<'z' | 'c' | 't', number>> | undefined,
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
  selections: Array<Partial<{ z: number; c: number; t: number }>>,
): void {
  const axisSizes =
    imageData.selectionAxisSizes ?? getVivSelectionAxisSizes(loaderObj.labels, loaderObj.shape);
  const channelCount = channelCountFromLoader(loaderObj, axisSizes);
  const maxValue = maxValueFromLoaderMetadata(loaderObj);
  imageData.contrastLimits = Array.from({ length: channelCount }, () => [0, maxValue] as [number, number]);
  imageData.colors =
    channelCount === 1
      ? [[255, 255, 255] as [number, number, number]]
      : Array.from({ length: channelCount }, (_, i) =>
          COLOR_PALLETE[i % COLOR_PALLETE.length] as [number, number, number],
        );
  imageData.channelsVisible = Array(channelCount).fill(true);
  imageData.selections = selections;
}
