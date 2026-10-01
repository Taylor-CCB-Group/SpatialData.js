export const WEBGPU_CANVAS_SIZE = 512;

/**
 * Quadrant centres. Label 1 fills the top-left quadrant and label 2 the bottom-right;
 * the other two are background. The layout is asymmetric in y on purpose: a pick
 * that reads the mirrored row lands on background, so a vertical flip in the pick
 * path cannot pass for a correct pick.
 */
export const WEBGPU_SAMPLE_POINTS = {
  label1: [WEBGPU_CANVAS_SIZE * 0.25, WEBGPU_CANVAS_SIZE * 0.25],
  label2: [WEBGPU_CANVAS_SIZE * 0.75, WEBGPU_CANVAS_SIZE * 0.75],
  background: [WEBGPU_CANVAS_SIZE * 0.75, WEBGPU_CANVAS_SIZE * 0.25],
} as const;

export interface LabelsPickWebGPUState {
  /** The luma device type deck ended up on, once it has one. */
  deviceType: string | null;
  /** True once the labels raster has a WebGPU tile layer to pick from. */
  ready: boolean;
  errors: string[];
}
