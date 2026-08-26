import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  disableParquetWorker,
  enableParquetWorker,
  setParquetWorkerDefaultEnabled,
  setParquetWorkerRequestTimeout,
  streamGeometryWithFeaturesInWorker,
} from '../src/workers/parquetWorkerClient.js';
import type {
  ParquetWorkerMessage,
  ParquetWorkerRequest,
  ParquetWorkerResponse,
  ParquetWorkerStreamChunk,
} from '../src/workers/parquetWorkerProtocol.js';

/**
 * The streaming protocol, exercised against a scripted worker.
 *
 * `streamGeometryWithFeatures` is the only request type that posts more than one
 * message per id, and the client's request/response machinery had to grow to fit
 * it: an interim message must NOT settle the pending entry, and the silence
 * watchdog has to measure time since the last message rather than time since the
 * request went out. Both are easy to regress into a stream that either resolves on
 * its first batch or times out mid-flight, and neither shows up in a type check —
 * hence these.
 */

const STREAM_INPUT = {
  partUrls: ['https://example.test/points/part-0.parquet'],
  axisNames: ['x', 'y'],
  featureKey: 'feature_name',
  maxRows: 1_000,
  batchSize: 100,
};

/** A batch of `rows` rows, all of one feature, with x = y = the row's index. */
function batch(partIndex: number, rows: number, feature: { code: number; name: string } | null) {
  const xs = Float32Array.from({ length: rows }, (_, index) => index);
  const chunk: ParquetWorkerStreamChunk = {
    kind: 'geometryWithFeaturesBatch',
    partIndex,
    partCount: 1,
    rows,
    axes: [xs, xs.slice()],
    featureCodes: new Int32Array(rows).fill(feature ? feature.code : 0),
    newFeatures: feature ? [feature] : [],
    tallyCodes: Int32Array.from([feature ? feature.code : 0]),
    tallyCounts: Uint32Array.from([rows]),
  };
  return chunk;
}

type Scripted = {
  /** Every request the client posted, in order. */
  posted: ParquetWorkerRequest[];
  /** Ids the client posted, parallel to {@link posted}. */
  postedIds: number[];
  /** Push an interim chunk under the first stream request's id. */
  emit(chunk: ParquetWorkerStreamChunk): void;
  /** Post the terminal response under the first stream request's id. */
  finish(response: ParquetWorkerResponse): void;
  /** Fire an `error` event, as a live worker that threw would. */
  fail(detail: string): void;
};

/**
 * Install a Worker that records requests and replies only when told to, so each
 * test drives the message sequence itself.
 */
function installScriptedWorker(): Scripted {
  const state: Partial<Scripted> & { instance?: FakeWorker } = { posted: [], postedIds: [] };
  let streamId: number | undefined;

  class FakeWorker {
    onmessage: ((event: MessageEvent<ParquetWorkerMessage>) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    constructor() {
      state.instance = this;
    }
    postMessage(message: ParquetWorkerMessage) {
      if (message.direction !== 'request') {
        return;
      }
      state.posted?.push(message.request);
      state.postedIds?.push(message.id);
      if (message.request.type === 'streamGeometryWithFeatures' && streamId === undefined) {
        streamId = message.id;
      }
    }
    terminate() {
      /* no-op */
    }
  }
  (globalThis as { Worker?: unknown }).Worker = FakeWorker;

  const deliver = (message: ParquetWorkerMessage) => {
    state.instance?.onmessage?.({ data: message } as MessageEvent<ParquetWorkerMessage>);
  };
  const scripted: Scripted = {
    posted: state.posted as ParquetWorkerRequest[],
    postedIds: state.postedIds as number[],
    emit(chunk) {
      if (streamId === undefined) {
        throw new Error('no stream request has been posted yet');
      }
      deliver({ id: streamId, direction: 'stream', chunk });
    },
    finish(response) {
      if (streamId === undefined) {
        throw new Error('no stream request has been posted yet');
      }
      deliver({ id: streamId, direction: 'response', response });
    },
    fail(detail) {
      state.instance?.onerror?.({ message: detail });
    },
  };
  return scripted;
}

describe('parquet worker streaming protocol', () => {
  const originalWorker = (globalThis as { Worker?: unknown }).Worker;

  afterEach(() => {
    disableParquetWorker();
    setParquetWorkerRequestTimeout(30_000);
    setParquetWorkerDefaultEnabled(false);
    (globalThis as { Worker?: unknown }).Worker = originalWorker;
  });

  it('returns null without a worker, so the caller streams on the main thread', async () => {
    disableParquetWorker();
    setParquetWorkerDefaultEnabled(false);
    await expect(streamGeometryWithFeaturesInWorker(STREAM_INPUT, () => {})).resolves.toBeNull();
  });

  it('delivers every interim batch and resolves on the terminal response', async () => {
    const scripted = installScriptedWorker();
    enableParquetWorker({ workerUrl: 'about:blank' });

    const seen: ParquetWorkerStreamChunk[] = [];
    const pending = streamGeometryWithFeaturesInWorker(STREAM_INPUT, (chunk) => seen.push(chunk));
    await Promise.resolve();

    scripted.emit(batch(0, 10, { code: 0, name: 'ABCC11' }));
    scripted.emit(batch(0, 10, { code: 1, name: 'ACE2' }));
    // Three interim messages under one id: the pending entry must survive all of
    // them. A settle-on-first-response client resolves here with the wrong value.
    scripted.emit(batch(0, 5, null));
    expect(seen).toHaveLength(3);

    scripted.finish({
      ok: true,
      result: { kind: 'geometryWithFeaturesStreamEnd', rows: 25, sawFeatureColumn: true },
    });
    await expect(pending).resolves.toEqual({ rows: 25, sawFeatureColumn: true });
  });

  it('reports a stream that ended without its feature column', async () => {
    const scripted = installScriptedWorker();
    enableParquetWorker({ workerUrl: 'about:blank' });
    const pending = streamGeometryWithFeaturesInWorker(STREAM_INPUT, () => {});
    await Promise.resolve();
    scripted.finish({
      ok: true,
      result: { kind: 'geometryWithFeaturesStreamEnd', rows: 40, sawFeatureColumn: false },
    });
    await expect(pending).resolves.toEqual({ rows: 40, sawFeatureColumn: false });
  });

  describe('the silence watchdog', () => {
    // Fake timers, deliberately. These assert a RELATIONSHIP between the budget and
    // the gaps between messages, and a real-timer version of the first one — six
    // 20ms sleeps under a 60ms budget — fails whenever the machine is busy enough
    // for one sleep to overrun. That is a flake, not a finding.
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('does not fire while batches keep arriving, however long the stream runs', async () => {
      const scripted = installScriptedWorker();
      enableParquetWorker({ workerUrl: 'about:blank' });
      setParquetWorkerRequestTimeout(60);

      const seen: ParquetWorkerStreamChunk[] = [];
      const pending = streamGeometryWithFeaturesInWorker(STREAM_INPUT, (chunk) => seen.push(chunk));
      await Promise.resolve();

      // Six batches 20ms apart is 120ms of streaming under a 60ms budget: a
      // time-since-POSTED timeout abandons this healthy stream half way through.
      for (let index = 0; index < 6; index += 1) {
        await vi.advanceTimersByTimeAsync(20);
        scripted.emit(batch(0, 10, index === 0 ? { code: 0, name: 'ABCC11' } : null));
      }
      scripted.finish({
        ok: true,
        result: { kind: 'geometryWithFeaturesStreamEnd', rows: 60, sawFeatureColumn: true },
      });

      await expect(pending).resolves.toEqual({ rows: 60, sawFeatureColumn: true });
      expect(seen).toHaveLength(6);
    });

    it('fires when a started stream goes quiet, and tells the worker to stop', async () => {
      const scripted = installScriptedWorker();
      enableParquetWorker({ workerUrl: 'about:blank' });
      setParquetWorkerRequestTimeout(40);

      const pending = streamGeometryWithFeaturesInWorker(STREAM_INPUT, () => {});
      await Promise.resolve();
      const streamId = scripted.postedIds[0];
      scripted.emit(batch(0, 10, { code: 0, name: 'ABCC11' }));

      const settled = expect(pending).rejects.toThrow(/stream went quiet for 40ms/);
      await vi.advanceTimersByTimeAsync(41);
      await settled;
      // Otherwise the worker keeps range-fetching a payload nobody will read.
      expect(scripted.posted).toContainEqual({
        type: 'cancelParquetStream',
        streamRequestId: streamId,
      });
    });

    it('keeps the original wording for a request that never answered at all', async () => {
      const scripted = installScriptedWorker();
      enableParquetWorker({ workerUrl: 'about:blank' });
      setParquetWorkerRequestTimeout(30);
      const pending = streamGeometryWithFeaturesInWorker(STREAM_INPUT, () => {});
      const settled = expect(pending).rejects.toThrow(/did not respond within 30ms/);
      await vi.advanceTimersByTimeAsync(31);
      await settled;
      expect(scripted.posted[0]?.type).toBe('streamGeometryWithFeatures');
    });
  });

  describe('a stream that fails part way through', () => {
    it('rejects even though batches were already delivered', async () => {
      const scripted = installScriptedWorker();
      enableParquetWorker({ workerUrl: 'about:blank' });

      const seen: ParquetWorkerStreamChunk[] = [];
      const pending = streamGeometryWithFeaturesInWorker(STREAM_INPUT, (chunk) => seen.push(chunk));
      await Promise.resolve();

      scripted.emit(batch(0, 10, { code: 0, name: 'ABCC11' }));
      scripted.emit(batch(0, 10, null));
      scripted.finish({ ok: false, error: 'range read failed on part 1' });

      // Partial success is NOT reported as success: downstream cannot tell a
      // truncated preload from a complete one, so the caller must restart.
      await expect(pending).rejects.toThrow(/range read failed on part 1/);
      expect(seen).toHaveLength(2);
    });

    it('rejects when a live worker throws mid-stream, and stays enabled', async () => {
      const scripted = installScriptedWorker();
      enableParquetWorker({ workerUrl: 'about:blank' });

      const seen: ParquetWorkerStreamChunk[] = [];
      const pending = streamGeometryWithFeaturesInWorker(STREAM_INPUT, (chunk) => seen.push(chunk));
      await Promise.resolve();
      scripted.emit(batch(0, 10, { code: 0, name: 'ABCC11' }));

      // A worker that has posted chunks has demonstrably loaded, so an error event
      // is "this request died", not "the bundle is missing" — the stream rejects
      // but the worker must survive for the next request.
      scripted.fail('decode panicked');
      await expect(pending).rejects.toThrow(/decode panicked/);
      expect(seen).toHaveLength(1);

      const next = streamGeometryWithFeaturesInWorker(STREAM_INPUT, () => {});
      await Promise.resolve();
      expect(scripted.posted.filter((r) => r.type === 'streamGeometryWithFeatures')).toHaveLength(
        2
      );
      disableParquetWorker();
      await expect(next).rejects.toThrow();
    });

    it('rejects and cancels when the consumer throws on a batch', async () => {
      const scripted = installScriptedWorker();
      enableParquetWorker({ workerUrl: 'about:blank' });

      const pending = streamGeometryWithFeaturesInWorker(STREAM_INPUT, () => {
        throw new Error('accumulator overflowed');
      });
      await Promise.resolve();
      const streamId = scripted.postedIds[0];
      scripted.emit(batch(0, 10, { code: 0, name: 'ABCC11' }));

      await expect(pending).rejects.toThrow(/accumulator overflowed/);
      expect(scripted.posted).toContainEqual({
        type: 'cancelParquetStream',
        streamRequestId: streamId,
      });
    });

    it('ignores a batch that arrives after the request settled', async () => {
      const scripted = installScriptedWorker();
      enableParquetWorker({ workerUrl: 'about:blank' });

      const seen: ParquetWorkerStreamChunk[] = [];
      const pending = streamGeometryWithFeaturesInWorker(STREAM_INPUT, (chunk) => seen.push(chunk));
      await Promise.resolve();
      scripted.emit(batch(0, 10, { code: 0, name: 'ABCC11' }));
      scripted.finish({ ok: false, error: 'gave up' });
      await expect(pending).rejects.toThrow(/gave up/);

      // A batch already in flight behind the cancel. Dropping it must not throw.
      expect(() => scripted.emit(batch(0, 10, null))).not.toThrow();
      expect(seen).toHaveLength(1);
    });
  });

  describe('abort', () => {
    it('rejects and cancels the worker-side stream when the load is superseded', async () => {
      const scripted = installScriptedWorker();
      enableParquetWorker({ workerUrl: 'about:blank' });

      const controller = new AbortController();
      const seen: ParquetWorkerStreamChunk[] = [];
      const pending = streamGeometryWithFeaturesInWorker(
        { ...STREAM_INPUT, signal: controller.signal },
        (chunk) => seen.push(chunk)
      );
      await Promise.resolve();
      const streamId = scripted.postedIds[0];
      scripted.emit(batch(0, 10, { code: 0, name: 'ABCC11' }));

      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      expect(seen).toHaveLength(1);
      // Superseding a load has to stop the worker FETCHING, not just stop us
      // listening — otherwise a few pans queue several whole-element downloads.
      expect(scripted.posted).toContainEqual({
        type: 'cancelParquetStream',
        streamRequestId: streamId,
      });
    });

    it('never posts a request for an already-aborted signal', async () => {
      const scripted = installScriptedWorker();
      enableParquetWorker({ workerUrl: 'about:blank' });
      const controller = new AbortController();
      controller.abort();
      await expect(
        streamGeometryWithFeaturesInWorker({ ...STREAM_INPUT, signal: controller.signal }, () => {})
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(scripted.posted).toHaveLength(0);
    });
  });

  it('fails every in-flight stream when the worker is torn down', async () => {
    installScriptedWorker();
    enableParquetWorker({ workerUrl: 'about:blank' });
    const first = streamGeometryWithFeaturesInWorker(STREAM_INPUT, () => {});
    const second = streamGeometryWithFeaturesInWorker(STREAM_INPUT, () => {});
    await Promise.resolve();
    disableParquetWorker();
    await expect(first).rejects.toThrow(/disabled/);
    await expect(second).rejects.toThrow(/disabled/);
  });
});
