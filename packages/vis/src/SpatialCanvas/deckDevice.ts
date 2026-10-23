import type { Device } from '@luma.gl/core';
import { applyWebGPUPickingFix, applyWebGPUViewFix } from '@spatialdata/layers';

/**
 * `onDeviceInitialized` for the SpatialCanvas viewers: applies the WebGPU picking and
 * view workarounds (see `applyWebGPUPickingFix`, `applyWebGPUViewFix`), then calls the
 * consumer's own handler.
 */
export function withWebGPUFixes(
  onDeviceInitialized?: (device: Device) => void
): (device: Device) => void {
  return (device) => {
    applyWebGPUPickingFix(device);
    applyWebGPUViewFix(device);
    // A throw here escapes into deck's start-up and stops its render loop, leaving a
    // blank canvas with only an unhandled rejection to show for it.
    try {
      onDeviceInitialized?.(device);
    } catch (error) {
      console.error('onDeviceInitialized threw:', error);
    }
  };
}
