/**
 * The colours and readback shape shared by the labels colour-by scenario and its
 * spec.
 *
 * Deliberately free of any `@spatialdata/*` import: Playwright loads the spec in
 * Node, and the scenario module pulls in the browser-only built layers bundle, so
 * a spec that imported the scenario directly would fail to collect at all.
 */

export const LABEL_1_COLOR = [255, 0, 0, 255] as const;
export const LABEL_2_COLOR = [0, 128, 255, 255] as const;
/** Deliberately neither feature colour, so a fallback to it is unmistakable. */
export const CHANNEL_COLOR = [255, 255, 255] as const;

export type SampledPixel = [number, number, number, number];

export interface LabelsColorBySamples {
  label1: SampledPixel;
  label2: SampledPixel;
}
