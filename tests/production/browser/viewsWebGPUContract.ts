export const VIEWS_CANVAS_SIZE = 200;

/** Low on the canvas on purpose: its vertical mirror is clear of it. */
export const VIEWS_INSET = { x: 110, y: 130, width: 80, height: 60 };

/** The inset's clear colour, and the canvas pixels sampled after each frame. */
export const VIEWS_CLEAR_COLOR = [255, 0, 255, 255] as const;
export const VIEWS_SAMPLE_POINTS = {
  inset: [150, 160],
  mirrored: [150, 40],
  outside: [50, 160],
} as const;

export type ViewsSample = keyof typeof VIEWS_SAMPLE_POINTS;

export interface ViewsWebGPUState {
  /** The luma device type deck ended up on, once it has one. */
  deviceType: string | null;
  /** `rgba` of each sample point in the last frame drawn, or null before one. */
  samples: Record<ViewsSample, number[]> | null;
  errors: string[];
}
