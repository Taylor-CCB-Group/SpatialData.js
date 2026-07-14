import { afterEach, describe, expect, it, vi } from 'vitest';
import { filterColumnarByFeatureCodes as filterSync } from '../src/pointsTiling.js';
import {
  decodeParquetRowFeatureCodesInWorker,
  disablePointsWorker,
  enablePointsWorker,
  filterColumnarByFeatureCodesInWorker,
  scanParquetFeatureCatalogInWorker,
  setPointsWorkerDefaultEnabled,
  setPointsWorkerRequestTimeout,
} from '../src/workers/pointsWorkerClient.js';

describe('points worker client', () => {
  it('falls back to main-thread filtering when the worker is disabled', async () => {
    setPointsWorkerDefaultEnabled(false);
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
    disablePointsWorker();
    setPointsWorkerDefaultEnabled(false);
    const result = await decodeParquetRowFeatureCodesInWorker({
      parts: [new Uint8Array([1, 2, 3])],
      columns: ['feature_name'],
      featureKey: 'feature_name',
    });
    expect(result).toBeNull();
  });

  it('returns null for feature catalog scan when the worker is disabled', async () => {
    disablePointsWorker();
    setPointsWorkerDefaultEnabled(false);
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
      disablePointsWorker();
      setPointsWorkerRequestTimeout(30_000);
      setPointsWorkerDefaultEnabled(false);
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

      enablePointsWorker({ workerUrl: 'about:blank' });
      setPointsWorkerRequestTimeout(30);

      await expect(
        scanParquetFeatureCatalogInWorker({
          parts: [new Uint8Array([1, 2, 3])],
          columns: ['feature_name'],
          featureKey: 'feature_name',
        })
      ).rejects.toThrow(/did not respond within 30ms/);
    });
  });
});
