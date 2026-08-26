import { afterEach, describe, expect, it, vi } from 'vitest';
import { filterColumnarByFeatureCodes as filterSync } from '../src/pointsTiling.js';
import {
  decodeParquetRowFeatureCodesInWorker,
  disableParquetWorker,
  enableParquetWorker,
  ensureParquetWorker,
  filterColumnarByFeatureCodesInWorker,
  isParquetWorkerEnabled,
  scanParquetFeatureCatalogInWorker,
  setParquetWorkerDefaultEnabled,
  setParquetWorkerRequestTimeout,
} from '../src/workers/parquetWorkerClient.js';

describe('parquet worker client', () => {
  it('falls back to main-thread filtering when the worker is disabled', async () => {
    setParquetWorkerDefaultEnabled(false);
    const data = {
      shape: [2, 4] as [number, number],
      data: [Float32Array.from([0, 1, 2, 3]), Float32Array.from([0, 1, 2, 3])],
    };
    const sourceFeatureCodes = Int32Array.from([0, 1, 0, 2]);
    const filtered = await filterColumnarByFeatureCodesInWorker(data, [1], sourceFeatureCodes);
    const expected = filterSync(data, [1], sourceFeatureCodes);
    expect(filtered.shape).toEqual(expected.shape);
    expect(Array.from(filtered.data[0])).toEqual(Array.from(expected.data[0]));
    expect(Array.from(filtered.data[1])).toEqual(Array.from(expected.data[1]));
  });

  it('returns null for row feature code decode when the worker is disabled', async () => {
    disableParquetWorker();
    setParquetWorkerDefaultEnabled(false);
    const result = await decodeParquetRowFeatureCodesInWorker({
      parts: [new Uint8Array([1, 2, 3])],
      columns: ['feature_name'],
      featureKey: 'feature_name',
    });
    expect(result).toBeNull();
  });

  it('returns null for feature catalog scan when the worker is disabled', async () => {
    disableParquetWorker();
    setParquetWorkerDefaultEnabled(false);
    const result = await scanParquetFeatureCatalogInWorker({
      parts: [new Uint8Array([1, 2, 3])],
      columns: ['feature_name'],
      featureKey: 'feature_name',
    });
    expect(result).toBeNull();
  });

  describe('timeout fallback for a silent worker', () => {
    const originalWorker = (globalThis as { Worker?: unknown }).Worker;

    afterEach(() => {
      disableParquetWorker();
      setParquetWorkerRequestTimeout(30_000);
      setParquetWorkerDefaultEnabled(false);
      (globalThis as { Worker?: unknown }).Worker = originalWorker;
    });

    it('rejects (so the caller can fall back) when an enabled worker never replies', async () => {
      // A worker that loads but never posts a response — the exact hang the
      // opt-in default guards against, here caught by the request timeout.
      class SilentWorker {
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: unknown) => void) | null = null;
        postMessage() {
          /* deliberately never reply */
        }
        terminate() {
          /* no-op */
        }
      }
      (globalThis as { Worker?: unknown }).Worker = SilentWorker;

      enableParquetWorker({ workerUrl: 'about:blank' });
      setParquetWorkerRequestTimeout(30);

      await expect(
        scanParquetFeatureCatalogInWorker({
          parts: [new Uint8Array([1, 2, 3])],
          columns: ['feature_name'],
          featureKey: 'feature_name',
        })
      ).rejects.toThrow(/did not respond within 30ms/);
    });
  });

  describe('a worker that never loads', () => {
    const originalWorker = (globalThis as { Worker?: unknown }).Worker;

    afterEach(() => {
      disableParquetWorker();
      setParquetWorkerDefaultEnabled(false);
      (globalThis as { Worker?: unknown }).Worker = originalWorker;
      vi.restoreAllMocks();
    });

    /** A worker whose URL 404s: one `error` event, then silence. Counts instances. */
    function installDeadOnArrivalWorker(): { count: number } {
      const constructed = { count: 0 };
      class DeadWorker {
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: unknown) => void) | null = null;
        constructor() {
          constructed.count += 1;
          queueMicrotask(() => this.onerror?.({ message: 'Failed to fetch worker' }));
        }
        postMessage() {
          /* never reaches a worker */
        }
        terminate() {
          /* no-op */
        }
      }
      (globalThis as { Worker?: unknown }).Worker = DeadWorker;
      return constructed;
    }

    it('switches itself off, so callers fall back instead of waiting for a timeout', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      installDeadOnArrivalWorker();

      enableParquetWorker({ workerUrl: 'https://example.invalid/parquet-worker.js' });
      expect(isParquetWorkerEnabled()).toBe(true);

      // The load failure lands a microtask later, as a real one would.
      await Promise.resolve();
      expect(isParquetWorkerEnabled()).toBe(false);
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('workerUrl'));

      // The caller now takes the main-thread path rather than posting into the void.
      const data = {
        shape: [2, 4] as [number, number],
        data: [Float32Array.from([0, 1, 2, 3]), Float32Array.from([0, 1, 2, 3])],
      };
      const sourceFeatureCodes = Int32Array.from([0, 1, 0, 2]);
      const filtered = await filterColumnarByFeatureCodesInWorker(data, [1], sourceFeatureCodes);
      expect(Array.from(filtered.data[0])).toEqual(
        Array.from(filterSync(data, [1], sourceFeatureCodes).data[0])
      );
    });

    it('does not rebuild the failed worker on every ensure() call', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const constructed = installDeadOnArrivalWorker();

      setParquetWorkerDefaultEnabled(true);
      ensureParquetWorker();
      await Promise.resolve();
      ensureParquetWorker();
      ensureParquetWorker();

      expect(constructed.count).toBe(1);
      expect(isParquetWorkerEnabled()).toBe(false);
    });
  });
});
