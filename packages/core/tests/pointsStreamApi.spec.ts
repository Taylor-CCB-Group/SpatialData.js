import { describe, expect, it, vi } from 'vitest';
import SpatialDataPointsSource from '../src/models/VPointsSource.js';
import type { PointsLoadProgress } from '../src/pointsLoadOptions.js';
import * as parquetWorkerClient from '../src/workers/parquetWorkerClient.js';
import type { ParquetWorkerStreamChunk } from '../src/workers/parquetWorkerProtocol.js';

/**
 * `streamPoints` — the async-iterable form of `loadPoints` (#175).
 *
 * Two things to pin. That the iterable really is the producer: `loadPoints` drains
 * it, so a tick the stream yields is a tick `onProgress` receives, and the two
 * cannot drift. And that adding it changed nothing for existing callers —
 * `loadPoints` without an `onProgress` must still take the one-shot decode.
 */

/** A worker stream batch of `rows` rows, all of one feature. */
function chunk(rows: number, feature: { code: number; name: string }): ParquetWorkerStreamChunk {
  const xs = Float32Array.from({ length: rows }, (_, index) => index);
  return {
    kind: 'geometryWithFeaturesBatch',
    partIndex: 0,
    partCount: 1,
    rows,
    axes: [xs, xs.slice()],
    featureCodes: new Int32Array(rows).fill(feature.code),
    newFeatures: [feature],
    tallyCodes: Int32Array.from([feature.code]),
    tallyCounts: Uint32Array.from([rows]),
  };
}

/** A source whose element metadata and part URLs are stubbed, so only the read
 * strategy under test is exercised. */
function pointsSource() {
  const source = new SpatialDataPointsSource({
    store: { get: async () => null },
    fileType: '.zarr',
  });
  vi.spyOn(source, 'loadSpatialDataElementAttrs').mockResolvedValue({
    'encoding-type': 'ngff:points',
    axes: ['x', 'y'],
    spatialdata_attrs: { feature_key: 'feature_name', version: '0.2' },
  });
  vi.spyOn(source, 'resolveParquetRowCount').mockResolvedValue(30);
  vi.spyOn(source, 'canLoadParquetRowGroups').mockResolvedValue(false);
  vi.spyOn(source, 'loadParquetDatasetMetadata').mockResolvedValue(null);
  vi.spyOn(source, 'loadParquetSchemaTable').mockResolvedValue(null);
  // Private, but it is the capability gate the streaming readers consult and there
  // is no public seam for it.
  vi.spyOn(
    source as unknown as { resolveStreamablePartUrls: () => Promise<string[]> },
    'resolveStreamablePartUrls'
  ).mockResolvedValue(['https://example.test/part-0.parquet']);
  vi.spyOn(parquetWorkerClient, 'isParquetWorkerEnabled').mockReturnValue(true);
  vi.spyOn(parquetWorkerClient, 'ensureParquetWorker').mockImplementation(() => {});
  return source;
}

/** Stub the worker stream with a scripted generator, recording whether the
 * consumer closed it early. */
function scriptWorkerStream(chunks: ParquetWorkerStreamChunk[]) {
  const state = { closed: false, delivered: 0 };
  vi.spyOn(parquetWorkerClient, 'streamGeometryWithFeaturesInWorker').mockImplementation(
    async function* () {
      try {
        for (const item of chunks) {
          state.delivered += 1;
          yield item;
        }
        return { rows: chunks.reduce((sum, c) => sum + c.rows, 0), sawFeatureColumn: true };
      } finally {
        state.closed = true;
      }
    }
  );
  return state;
}

describe('streamPoints', () => {
  it('yields the growing result and returns the settled one', async () => {
    const source = pointsSource();
    scriptWorkerStream([
      chunk(10, { code: 0, name: 'ABCC11' }),
      chunk(10, { code: 1, name: 'ACE2' }),
    ]);

    const stream = source.streamPoints('points/transcripts', { includeFeatureCodes: true });
    const ticks: PointsLoadProgress[] = [];
    let settled: Awaited<ReturnType<typeof source.loadPoints>> | undefined;
    for (;;) {
      const next = await stream.next();
      if (next.done) {
        settled = next.value;
        break;
      }
      ticks.push(next.value);
    }

    expect(ticks.map((tick) => tick.matchedRows)).toEqual([10, 20]);
    // Cumulative, not deltas — which is what makes `coalesceLatest` safe over this
    // stream, and why the last tick and the return value agree on row count.
    expect(ticks[0].partialResult.shape[1]).toBe(10);
    expect(settled?.shape[1]).toBe(20);
    expect(settled?.featureCatalog?.entries.map((entry) => entry.name)).toEqual(['ABCC11', 'ACE2']);
  });

  it('gives loadPoints onProgress exactly the ticks the stream yields', async () => {
    const source = pointsSource();
    scriptWorkerStream([
      chunk(10, { code: 0, name: 'ABCC11' }),
      chunk(10, { code: 1, name: 'ACE2' }),
      chunk(5, { code: 2, name: 'ACKR1' }),
    ]);

    const seen: number[] = [];
    const result = await source.loadPoints('points/transcripts', {
      includeFeatureCodes: true,
      onProgress: (progress) => seen.push(progress.matchedRows),
    });

    // The deprecated callback is a drain of the same generator, so this IS the
    // stream's tick sequence — not a parallel implementation of it.
    expect(seen).toEqual([10, 20, 25]);
    expect(result.shape[1]).toBe(25);
  });

  it('closes the underlying worker stream when the consumer stops early', async () => {
    const source = pointsSource();
    const state = scriptWorkerStream([
      chunk(10, { code: 0, name: 'ABCC11' }),
      chunk(10, { code: 1, name: 'ACE2' }),
      chunk(10, { code: 2, name: 'ACKR1' }),
    ]);

    for await (const _tick of source.streamPoints('points/transcripts', {
      includeFeatureCodes: true,
    })) {
      break;
    }

    // `break` propagates down the `yield*` chain to the worker stream's `finally`,
    // which is where the cancel is posted. Nothing here asks for cancellation.
    expect(state.closed).toBe(true);
    expect(state.delivered).toBeLessThan(3);
  });

  it('leaves loadPoints without onProgress on its one-shot decode', async () => {
    const source = pointsSource();
    const streamed = scriptWorkerStream([chunk(10, { code: 0, name: 'ABCC11' })]);
    const oneShot = vi
      .spyOn(parquetWorkerClient, 'decodeGeometryWithFeaturesInWorker')
      .mockResolvedValue({
        shape: [2, 30],
        data: [new Float32Array(30), new Float32Array(30)],
      });
    vi.spyOn(
      source as unknown as { fetchParquetPayloadCapped: () => Promise<{ parts: Uint8Array[] }> },
      'fetchParquetPayloadCapped'
    ).mockResolvedValue({ parts: [new Uint8Array(1)] });

    const result = await source.loadPoints('points/transcripts', { includeFeatureCodes: true });

    // The path-selection gate is unchanged: no callback, no progressive read. A
    // caller that never asked for ticks must not silently get a different, slower
    // reader.
    expect(streamed.delivered).toBe(0);
    expect(oneShot).toHaveBeenCalled();
    expect(result.shape[1]).toBe(30);
  });
});
