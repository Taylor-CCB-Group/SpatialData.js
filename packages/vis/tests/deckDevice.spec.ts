import type { Device } from '@luma.gl/core';
import { describe, expect, it, vi } from 'vitest';
import { withWebGPUPickingFix } from '../src/SpatialCanvas/deckDevice.js';

// Only `type` is read on WebGL (the picking fix is WebGPU-only).
const webglDevice: Pick<Device, 'type'> = { type: 'webgl' };

describe('withWebGPUPickingFix', () => {
  it('passes the device to the consumer handler', () => {
    const handler = vi.fn();
    withWebGPUPickingFix(handler)(webglDevice as Device);
    expect(handler).toHaveBeenCalledWith(webglDevice);
  });

  it("logs a throwing consumer handler instead of breaking deck's start-up", () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onDeviceInitialized = withWebGPUPickingFix(() => {
      throw new Error('consumer bug');
    });
    expect(() => onDeviceInitialized(webglDevice as Device)).not.toThrow();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
