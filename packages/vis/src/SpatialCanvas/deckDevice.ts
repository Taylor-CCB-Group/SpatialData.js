import type { Device } from '@luma.gl/core';
import { applyWebGPUPickingFix } from '@spatialdata/layers';

/**
 * `onDeviceInitialized` for the SpatialCanvas viewers: applies the WebGPU picking
 * workaround (see `applyWebGPUPickingFix`), then calls the consumer's own handler.
 */
export function withWebGPUPickingFix(
  onDeviceInitialized?: (device: Device) => void
): (device: Device) => void {
  return (device) => {
    applyWebGPUPickingFix(device);
    onDeviceInitialized?.(device);
  };
}
