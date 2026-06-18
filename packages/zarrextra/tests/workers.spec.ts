import { afterEach, describe, expect, it, vi } from 'vitest';
import { getChunkDecodeBackend } from '../src/chunkDecode';
import { disableWorkerChunkDecode, enableWorkerChunkDecode } from '../src/workers/index';

vi.mock('@fideus-labs/worker-pool', () => {
  class MockWorkerPool {
    terminateWorkers = vi.fn();
  }
  return { WorkerPool: MockWorkerPool };
});

describe('worker chunk decode setup', () => {
  afterEach(() => {
    disableWorkerChunkDecode();
  });

  it('enables the fizarrita chunk decode backend', () => {
    enableWorkerChunkDecode({ workers: 2 });
    expect(getChunkDecodeBackend()).toMatchObject({
      kind: 'fizarrita',
      options: {
        workerUrl: expect.any(URL),
      },
    });
  });

  it('resets to main-thread decode on disable', () => {
    const pool = enableWorkerChunkDecode({ workers: 2 });
    disableWorkerChunkDecode();
    expect(getChunkDecodeBackend()).toEqual({ kind: 'main' });
    expect(pool.terminateWorkers).toHaveBeenCalledOnce();
  });
});
