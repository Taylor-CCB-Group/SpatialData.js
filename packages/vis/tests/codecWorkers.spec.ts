import { beforeEach, describe, expect, it, vi } from 'vitest';

const enableWorkerChunkDecode = vi.hoisted(() => vi.fn());

vi.mock('zarrextra/workers', () => ({
  enableWorkerChunkDecode,
}));

describe('ensureCodecWorkers', () => {
  beforeEach(() => {
    vi.resetModules();
    enableWorkerChunkDecode.mockClear();
    Reflect.deleteProperty(globalThis, 'Worker');
  });

  it('does nothing outside browser worker environments', async () => {
    const { ensureCodecWorkers } = await import('../src/codecWorkers');

    expect(ensureCodecWorkers()).toBe(false);
    expect(enableWorkerChunkDecode).not.toHaveBeenCalled();
  });

  it('enables the bundled codec worker once', async () => {
    Object.defineProperty(globalThis, 'Worker', {
      value: class TestWorker {},
      configurable: true,
    });
    const { ensureCodecWorkers } = await import('../src/codecWorkers');

    expect(ensureCodecWorkers()).toBe(true);
    expect(ensureCodecWorkers()).toBe(true);
    expect(enableWorkerChunkDecode).toHaveBeenCalledOnce();
    expect(enableWorkerChunkDecode).toHaveBeenCalledWith();
  });
});
