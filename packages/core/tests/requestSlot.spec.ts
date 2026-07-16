import { describe, expect, it, vi } from 'vitest';
import type { SpatialEntryErrorContext } from '../src/engine/errors.js';
import { RequestSlot, type SlotLoadContext } from '../src/engine/RequestSlot.js';

/**
 * `RequestSlot<K, V>`, driven headless.
 *
 * This is the primitive Track A hangs the four points slots off; the two rules it
 * must uphold — supersession by record identity, and "everything the request
 * depends on lives in K" — are exactly what closes races R1/R2/R3/R5 once the
 * slots consume it. Those rules are pinned here, at the primitive, so the per-slot
 * race specs in A2/A3 only have to prove the *keys* are right.
 */

const context: SpatialEntryErrorContext = {
  elementKey: 'transcripts',
  kind: 'points',
  resource: 'test',
  fallback: 'load-failed',
};

const slot = <K, V>(
  over: Partial<{ equals: (a: K, b: K) => boolean; onChange: () => void }> = {}
) => new RequestSlot<K, V>({ context, ...over });

/** A loader whose settlement you control, so two loads can be interleaved. */
function deferred<V>() {
  let resolve!: (value: V) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<V>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('initial state', () => {
  it('is idle, with no value and no pending', () => {
    const s = slot<number, string>();
    expect(s.resolution.status).toBe('idle');
    expect(s.value).toBeUndefined();
    expect(s.pending).toBeUndefined();
  });
});

describe('request → loading → ready', () => {
  it('goes loading then ready, and calls the loader once', async () => {
    const s = slot<number, string>();
    const loader = vi.fn(async () => 'v');
    const p = s.request(4, loader);
    expect(s.isLoading).toBe(true);
    await p;
    expect(s.isReady).toBe(true);
    expect(s.value).toBe('v');
    expect(s.settledKey).toBe(4);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('notifies onChange for each transition', async () => {
    const onChange = vi.fn();
    const s = slot<number, string>({ onChange });
    await s.request(4, async () => 'v');
    // at least loading + ready
    expect(onChange.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('with notifyOnLoading:false, a clean load notifies once (settle only)', async () => {
    const onChange = vi.fn();
    const s = new RequestSlot<number, string>({ context, notifyOnLoading: false, onChange });
    await s.request(4, async () => 'v');
    // loading-start is quiet; only the settle fires. This is what keeps the
    // preload/rowCodes notify counts identical to the pre-slot engine.
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe('dedup by key', () => {
  it('a second request with the same key returns the same in-flight promise and does not re-run', () => {
    const s = slot<number, string>();
    const loader = vi.fn(async () => 'v');
    const first = s.request(4, loader);
    const second = s.request(4, loader);
    expect(second).toBe(first);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('a request for an already-ready key is a no-op', async () => {
    const s = slot<number, string>();
    const loader = vi.fn(async () => 'v');
    await s.request(4, loader);
    await s.request(4, loader);
    expect(loader).toHaveBeenCalledTimes(1);
  });
});

describe('supersession by record identity (R1/R2 essence)', () => {
  it('a superseded load cannot write its result even if it settles last', async () => {
    const s = slot<number, string>();
    const first = deferred<string>();
    const second = deferred<string>();
    const firstSignals: AbortSignal[] = [];

    s.request(4, (ctx: SlotLoadContext<string>) => {
      firstSignals.push(ctx.signal);
      return first.promise;
    });
    // Different key supersedes; the first record is now stale.
    const p2 = s.request(8, () => second.promise);

    // Second settles first, then the superseded first settles late.
    second.resolve('eight');
    await p2;
    expect(s.value).toBe('eight');

    first.resolve('four'); // must be dropped — this record is not current
    await Promise.resolve();
    await Promise.resolve();
    expect(s.value).toBe('eight');
    // The superseded load's signal was aborted.
    expect(firstSignals[0]?.aborted).toBe(true);
  });

  it('re-requesting the same key while a superseding load is in flight dedups to the live one', async () => {
    const s = slot<string, string>();
    const a = deferred<string>();
    const b = deferred<string>();
    s.request('sigA', () => a.promise);
    const pB = s.request('sigB', () => b.promise); // supersede
    const pB2 = s.request('sigB', () => b.promise); // R2: same signature → dedup, no 2nd scan
    expect(pB2).toBe(pB);
  });
});

describe('stale retention', () => {
  it('keeps the previous ready value as stale while a supersede loads', async () => {
    const s = slot<number, string>();
    await s.request(4, async () => 'first');
    const next = deferred<string>();
    s.request(8, () => next.promise);
    expect(s.isLoading).toBe(true);
    expect(s.value).toBeUndefined(); // ready value gone while loading
    expect(s.lastGood).toBe('first'); // but still drawable via stale
    next.resolve('second');
    await s.pending;
    expect(s.value).toBe('second');
  });
});

describe('failure and retry', () => {
  it('classifies a thrown error as failed + retryable, keeping stale', async () => {
    const s = slot<number, string>();
    await s.request(4, async () => 'good');
    await s.request(8, async () => {
      throw new Error('decode boom');
    });
    expect(s.isFailed).toBe(true);
    const r = s.resolution;
    if (r.status !== 'failed') throw new Error('expected failed');
    expect(r.error.retryable).toBe(true);
    expect(r.error.kind).toBe('load-failed');
    expect(r.stale).toBe('good'); // previous value retained
  });

  it('retry() re-runs the last loader and can reach ready', async () => {
    const s = slot<number, string>();
    let attempts = 0;
    const loader = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient');
      return 'recovered';
    };
    await s.request(8, loader);
    expect(s.isFailed).toBe(true);
    await s.retry();
    expect(s.isReady).toBe(true);
    expect(s.value).toBe('recovered');
    expect(attempts).toBe(2);
  });
});

describe('cancellation is a non-event', () => {
  it('an AbortError reverts to the last good value, not an error', async () => {
    const s = slot<number, string>();
    await s.request(4, async () => 'good');
    const gate = deferred<string>();
    const p = s.request(8, (ctx: SlotLoadContext<string>) => {
      ctx.signal.addEventListener('abort', () => {
        gate.reject(new DOMException('aborted', 'AbortError'));
      });
      return gate.promise;
    });
    // Reset aborts the in-flight load.
    s.reset();
    await p.catch(() => undefined);
    expect(s.isFailed).toBe(false);
  });
});

describe('streaming partials', () => {
  it('emit publishes partial + progress while loading, and is ignored after supersede', async () => {
    const s = slot<string, number[]>();
    let capturedEmit!: SlotLoadContext<number[]>['emit'];
    const gate = deferred<number[]>();
    s.request('scan', (ctx) => {
      capturedEmit = ctx.emit;
      return gate.promise;
    });
    capturedEmit([1, 2], { done: 2, scanned: 10 });
    expect(s.partial).toEqual([1, 2]);
    const r = s.resolution;
    if (r.status !== 'loading') throw new Error('expected loading');
    expect(r.progress).toEqual({ done: 2, scanned: 10 });

    // Supersede, then a late emit from the old scan must be dropped.
    s.request('scan2', () => deferred<number[]>().promise);
    capturedEmit([1, 2, 3]);
    expect(s.partial).toBeUndefined(); // new loading has no partial yet
  });

  it('a silent emit updates the partial without notifying', async () => {
    const onChange = vi.fn();
    const s = new RequestSlot<string, number[]>({ context, onChange });
    let emit!: SlotLoadContext<number[]>['emit'];
    s.request('scan', (ctx) => {
      emit = ctx.emit;
      return deferred<number[]>().promise;
    });
    onChange.mockClear(); // ignore the loading-start notify
    emit([1], undefined, { silent: true });
    expect(s.partial).toEqual([1]); // value fresh...
    expect(onChange).not.toHaveBeenCalled(); // ...but no re-render
    emit([1, 2]); // a loud tick flushes
    expect(s.partial).toEqual([1, 2]);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe('settle', () => {
  it('sets ready directly and cancels any in-flight load', async () => {
    const s = slot<number, string>();
    const never = deferred<string>();
    const signals: AbortSignal[] = [];
    s.request(4, (ctx) => {
      signals.push(ctx.signal);
      return never.promise;
    });
    s.settle(4, 'direct');
    expect(s.isReady).toBe(true);
    expect(s.value).toBe('direct');
    expect(signals[0]?.aborted).toBe(true);
  });
});

describe('reset', () => {
  it('aborts and returns to idle', async () => {
    const s = slot<number, string>();
    await s.request(4, async () => 'v');
    s.reset();
    expect(s.resolution.status).toBe('idle');
    expect(s.value).toBeUndefined();
  });
});
