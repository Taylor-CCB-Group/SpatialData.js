import { describe, expect, it, vi } from 'vitest';
import { ensureDemoWorkerChunkDecode } from '../demo/src/enableDemoWorkerChunkDecode';

const enableWorkerChunkDecode = vi.hoisted(() => vi.fn());

vi.mock('zarrextra/workers', () => ({
  enableWorkerChunkDecode,
}));

describe('ensureDemoWorkerChunkDecode', () => {
  it('enables worker chunk decode without caller-supplied worker URL', () => {
    Object.defineProperty(globalThis, 'Worker', {
      value: class DemoWorker {},
      configurable: true,
    });

    ensureDemoWorkerChunkDecode();

    expect(enableWorkerChunkDecode).toHaveBeenCalledWith();
  });
});
