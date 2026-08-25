import { beforeEach, describe, expect, it, vi } from 'vitest';

const enableParquetWorker = vi.hoisted(() => vi.fn());
const setParquetWorkerRequestTimeout = vi.hoisted(() => vi.fn());
const isParquetWorkerEnabled = vi.hoisted(() => vi.fn(() => true));
const ensureCodecWorkers = vi.hoisted(() => vi.fn(() => true));

vi.mock('@spatialdata/core', () => ({
  enableParquetWorker,
  isParquetWorkerEnabled,
  setParquetWorkerRequestTimeout,
}));
vi.mock('../src/codecWorkers', () => ({ ensureCodecWorkers }));

function installWorker() {
  Object.defineProperty(globalThis, 'Worker', {
    value: class TestWorker {},
    configurable: true,
  });
}

describe('ensureWorkers', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    isParquetWorkerEnabled.mockReturnValue(true);
    ensureCodecWorkers.mockReturnValue(true);
    Reflect.deleteProperty(globalThis, 'Worker');
  });

  it('starts both workers with no options at all', async () => {
    installWorker();
    const { ensureWorkers } = await import('../src/workers');

    expect(ensureWorkers()).toEqual({ codec: true, parquet: true });
    expect(ensureCodecWorkers).toHaveBeenCalledWith(undefined);
    expect(enableParquetWorker).toHaveBeenCalledWith({ workerUrl: undefined });
  });

  it('passes per-worker overrides through', async () => {
    installWorker();
    const { ensureWorkers } = await import('../src/workers');

    ensureWorkers({
      codec: { chunkCacheMaxBytes: 1024 },
      parquet: { workerUrl: 'https://example.test/w.js', requestTimeoutMs: 120_000 },
    });

    expect(ensureCodecWorkers).toHaveBeenCalledWith({ chunkCacheMaxBytes: 1024 });
    expect(enableParquetWorker).toHaveBeenCalledWith({
      workerUrl: 'https://example.test/w.js',
    });
    expect(setParquetWorkerRequestTimeout).toHaveBeenCalledWith(120_000);
  });

  it('leaves a worker alone when it is opted out', async () => {
    installWorker();
    const { ensureWorkers } = await import('../src/workers');

    expect(ensureWorkers({ codec: false })).toEqual({ codec: false, parquet: true });
    expect(ensureCodecWorkers).not.toHaveBeenCalled();
  });

  it('starts the parquet worker once, however often it is called', async () => {
    installWorker();
    const { ensureWorkers } = await import('../src/workers');

    ensureWorkers({ parquet: { workerUrl: 'https://example.test/w.js' } });
    ensureWorkers({ parquet: { workerUrl: 'https://example.test/w.js' } });
    ensureWorkers();

    // Rebuilding would replace a live worker mid-flight, and would clear core's
    // dead-worker latch — so a failed worker would be retried on every render.
    expect(enableParquetWorker).toHaveBeenCalledTimes(1);
  });

  it('reports the parquet worker as off once core says it failed to load', async () => {
    installWorker();
    const { ensureWorkers } = await import('../src/workers');

    ensureWorkers();
    isParquetWorkerEnabled.mockReturnValue(false);

    expect(ensureWorkers().parquet).toBe(false);
    expect(enableParquetWorker).toHaveBeenCalledTimes(1);
  });

  it('does nothing outside a browser', async () => {
    const { ensureWorkers } = await import('../src/workers');
    ensureCodecWorkers.mockReturnValue(false);

    expect(ensureWorkers()).toEqual({ codec: false, parquet: false });
    expect(enableParquetWorker).not.toHaveBeenCalled();
  });
});
