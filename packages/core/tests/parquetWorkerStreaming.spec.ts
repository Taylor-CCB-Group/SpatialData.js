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
 *
 * The helper is an async generator now (#175), not a promise plus an `onBatch`
 * callback. The behaviours below are deliberately unchanged — the same protocol read
 * through `for await` — plus two the callback shape could not express: leaving the
 * loop early cancels, and a partial failure is "consumed n items, then it threw".
 */

/**
 * Let a generator's queued body run. Async generator bodies are scheduled rather
 * than run synchronously on `next()`, and each queued chunk costs a few microtasks
 * to travel worker → queue → generator → consumer. The count bounds a wait rather
 * than asserting one. Microtasks, not timers: two suites here use fake timers.
 */
async function flush() {
  for (let index = 0; index < 32; index += 1) {
    await Promise.resolve();
  }
}

/** Consume a stream in the background, exposing its chunks and its end (or failure)
 * — the pull-side equivalent of the `onBatch` callback these tests used to pass. */
function drive(stream: AsyncGenerator<ParquetWorkerStreamChunk, unknown>) {
  const seen: ParquetWorkerStreamChunk[] = [];
  const done = (async () => {
    for (;;) {
      const next = await stream.next();
      if (next.done) {
        return next.value;
      }
      seen.push(next.value);
    }
  })();
  // Asserted on later; keep an early rejection from being reported as unhandled.
  done.catch(() => {});
  return { seen, done };
}

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
    // The RETURN value, not a yield: the generator ends immediately, which is the
    // caller's cue to fall through to the main-thread stream.
    await expect(streamGeometryWithFeaturesInWorker(STREAM_INPUT).next()).resolves.toEqual({
      done: true,
      value: null,
    });
  });

  it('delivers every interim batch and resolves on the terminal response', async () => {
    const scripted = installScriptedWorker();
    enableParquetWorker({ workerUrl: 'about:blank' });

    const { seen, done } = drive(streamGeometryWithFeaturesInWorker(STREAM_INPUT));
    await flush();

    scripted.emit(batch(0, 10, { code: 0, name: 'ABCC11' }));
    scripted.emit(batch(0, 10, { code: 1, name: 'ACE2' }));
    // Three interim messages under one id: the pending entry must survive all of
    // them. A settle-on-first-response client resolves here with the wrong value.
    scripted.emit(batch(0, 5, null));
    await flush();
    expect(seen).toHaveLength(3);

    scripted.finish({
      ok: true,
      result: { kind: 'geometryWithFeaturesStreamEnd', rows: 25, sawFeatureColumn: true },
    });
    await expect(done).resolves.toEqual({ rows: 25, sawFeatureColumn: true });
  });

  it('reports a stream that ended without its feature column', async () => {
    const scripted = installScriptedWorker();
    enableParquetWorker({ workerUrl: 'about:blank' });
    const { done } = drive(streamGeometryWithFeaturesInWorker(STREAM_INPUT));
    await flush();
    scripted.finish({
      ok: true,
      result: { kind: 'geometryWithFeaturesStreamEnd', rows: 40, sawFeatureColumn: false },
    });
    await expect(done).resolves.toEqual({ rows: 40, sawFeatureColumn: false });
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

      const { seen, done } = drive(streamGeometryWithFeaturesInWorker(STREAM_INPUT));
      await flush();

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

      await expect(done).resolves.toEqual({ rows: 60, sawFeatureColumn: true });
      expect(seen).toHaveLength(6);
    });

    it('fires when a started stream goes quiet, and tells the worker to stop', async () => {
      const scripted = installScriptedWorker();
      enableParquetWorker({ workerUrl: 'about:blank' });
      setParquetWorkerRequestTimeout(40);

      const { done } = drive(streamGeometryWithFeaturesInWorker(STREAM_INPUT));
      await flush();
      const streamId = scripted.postedIds[0];
      scripted.emit(batch(0, 10, { code: 0, name: 'ABCC11' }));

      const settled = expect(done).rejects.toThrow(/stream went quiet for 40ms/);
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
      const { done } = drive(streamGeometryWithFeaturesInWorker(STREAM_INPUT));
      await flush();
      const settled = expect(done).rejects.toThrow(/did not respond within 30ms/);
      await vi.advanceTimersByTimeAsync(31);
      await settled;
      expect(scripted.posted[0]?.type).toBe('streamGeometryWithFeatures');
    });
  });

  describe('a stream that fails part way through', () => {
    it('rejects even though batches were already delivered', async () => {
      const scripted = installScriptedWorker();
      enableParquetWorker({ workerUrl: 'about:blank' });

      const { seen, done } = drive(streamGeometryWithFeaturesInWorker(STREAM_INPUT));
      await flush();

      scripted.emit(batch(0, 10, { code: 0, name: 'ABCC11' }));
      scripted.emit(batch(0, 10, null));
      scripted.finish({ ok: false, error: 'range read failed on part 1' });

      // Partial success is NOT reported as success: downstream cannot tell a
      // truncated preload from a complete one, so the caller must restart. As an
      // iterable that is just the ordinary reading — two items consumed, then a
      // throw — rather than a contract note.
      await expect(done).rejects.toThrow(/range read failed on part 1/);
      expect(seen).toHaveLength(2);
    });

    it('rejects when a live worker throws mid-stream, and stays enabled', async () => {
      const scripted = installScriptedWorker();
      enableParquetWorker({ workerUrl: 'about:blank' });

      const { seen, done } = drive(streamGeometryWithFeaturesInWorker(STREAM_INPUT));
      await flush();
      scripted.emit(batch(0, 10, { code: 0, name: 'ABCC11' }));
      await flush();

      // A worker that has posted chunks has demonstrably loaded, so an error event
      // is "this request died", not "the bundle is missing" — the stream rejects
      // but the worker must survive for the next request.
      scripted.fail('decode panicked');
      await expect(done).rejects.toThrow(/decode panicked/);
      expect(seen).toHaveLength(1);

      const next = drive(streamGeometryWithFeaturesInWorker(STREAM_INPUT));
      await flush();
      expect(scripted.posted.filter((r) => r.type === 'streamGeometryWithFeatures')).toHaveLength(
        2
      );
      disableParquetWorker();
      await expect(next.done).rejects.toThrow();
    });

    it('rejects and cancels when the consumer throws on a batch', async () => {
      const scripted = installScriptedWorker();
      enableParquetWorker({ workerUrl: 'about:blank' });

      // A real `for await`: throwing from the body calls the generator's `return()`,
      // which is where the cancel is posted. The callback version had to route the
      // consumer's exception back through the message handler to get here.
      const consumer = (async () => {
        for await (const _chunk of streamGeometryWithFeaturesInWorker(STREAM_INPUT)) {
          throw new Error('accumulator overflowed');
        }
      })();
      consumer.catch(() => {});
      await flush();
      const streamId = scripted.postedIds[0];
      scripted.emit(batch(0, 10, { code: 0, name: 'ABCC11' }));

      await expect(consumer).rejects.toThrow(/accumulator overflowed/);
      expect(scripted.posted).toContainEqual({
        type: 'cancelParquetStream',
        streamRequestId: streamId,
      });
    });

    it('cancels the worker-side stream when the consumer just stops reading', async () => {
      const scripted = installScriptedWorker();
      enableParquetWorker({ workerUrl: 'about:blank' });

      // `break` IS cancellation — the property the callback shape had no way to
      // express, and the reason `cancelParquetStream` needed an explicit API call
      // before. Nothing here mentions cancelling.
      const taken: ParquetWorkerStreamChunk[] = [];
      const consumer = (async () => {
        for await (const chunk of streamGeometryWithFeaturesInWorker(STREAM_INPUT)) {
          taken.push(chunk);
          break;
        }
      })();
      await flush();
      const streamId = scripted.postedIds[0];
      scripted.emit(batch(0, 10, { code: 0, name: 'ABCC11' }));

      await consumer;
      expect(taken).toHaveLength(1);
      expect(scripted.posted).toContainEqual({
        type: 'cancelParquetStream',
        streamRequestId: streamId,
      });
    });

    it('ignores a batch that arrives after the request settled', async () => {
      const scripted = installScriptedWorker();
      enableParquetWorker({ workerUrl: 'about:blank' });

      const { seen, done } = drive(streamGeometryWithFeaturesInWorker(STREAM_INPUT));
      await flush();
      scripted.emit(batch(0, 10, { code: 0, name: 'ABCC11' }));
      scripted.finish({ ok: false, error: 'gave up' });
      await expect(done).rejects.toThrow(/gave up/);

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
      const { seen, done } = drive(
        streamGeometryWithFeaturesInWorker({ ...STREAM_INPUT, signal: controller.signal })
      );
      await flush();
      const streamId = scripted.postedIds[0];
      scripted.emit(batch(0, 10, { code: 0, name: 'ABCC11' }));
      await flush();

      controller.abort();
      await expect(done).rejects.toMatchObject({ name: 'AbortError' });
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
        streamGeometryWithFeaturesInWorker({
          ...STREAM_INPUT,
          signal: controller.signal,
        }).next()
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(scripted.posted).toHaveLength(0);
    });
  });

  it('fails every in-flight stream when the worker is torn down', async () => {
    installScriptedWorker();
    enableParquetWorker({ workerUrl: 'about:blank' });
    const first = drive(streamGeometryWithFeaturesInWorker(STREAM_INPUT));
    const second = drive(streamGeometryWithFeaturesInWorker(STREAM_INPUT));
    await flush();
    disableParquetWorker();
    await expect(first.done).rejects.toThrow(/disabled/);
    await expect(second.done).rejects.toThrow(/disabled/);
  });
});
