import { describe, expect, it } from 'vitest';
import {
  fromResult,
  Resolution,
  type SpatialEntryErrorContext,
  toSpatialEntryError,
} from '../src/engine/index.js';
import { CoordinateSystemNotFoundError } from '../src/models/index.js';
import { Err, Ok } from '../src/types.js';

const ctx: SpatialEntryErrorContext = {
  elementKey: 'cells',
  kind: 'shapes',
  resource: 'geometry',
  fallback: 'load-failed',
};

const anError = () => toSpatialEntryError(new Error('boom'), ctx);

describe('Resolution — identity', () => {
  // The identity rule is load-bearing: a fresh identity per render is a deck layer
  // teardown per frame, i.e. the pan flash this design exists to avoid.
  it('idle() is one frozen singleton, so it never churns identity', () => {
    expect(Resolution.idle()).toBe(Resolution.idle());
    expect(Object.isFrozen(Resolution.idle())).toBe(true);
  });

  it('ready() returns the value BY REFERENCE — it does not copy', () => {
    const value = { rows: new Float32Array([1, 2, 3]) };

    const resolved = Resolution.ready(value);

    expect(Resolution.readyValue(resolved)).toBe(value);
  });

  it('every other constructor allocates — which is why they are called at mutation time only', () => {
    // Documented so nobody "optimises" by calling ready() during render.
    expect(Resolution.ready(1)).not.toBe(Resolution.ready(1));
  });
});

describe('Resolution — the four states', () => {
  it('idle carries nothing', () => {
    expect(Resolution.idle().status).toBe('idle');
    expect(Resolution.readyValue(Resolution.idle())).toBeUndefined();
    expect(Resolution.lastGood(Resolution.idle())).toBeUndefined();
  });

  it('loading may carry partial, stale and progress — and omits absent keys entirely', () => {
    const bare = Resolution.loading<number>();
    expect(bare).toEqual({ status: 'loading' });
    expect('partial' in bare).toBe(false);
    expect('stale' in bare).toBe(false);

    const full = Resolution.loading({
      partial: 7,
      stale: 3,
      progress: { done: 7, scanned: 900, total: 1000 },
    });
    if (full.status !== 'loading') throw new Error('narrowing');
    expect(full.partial).toBe(7);
    expect(full.stale).toBe(3);
    // done vs scanned: a feature scan reads every row group but keeps only matches.
    expect(full.progress).toEqual({ done: 7, scanned: 900, total: 1000 });
  });

  it('ready omits an empty notices array rather than carrying it', () => {
    expect(Resolution.ready(1, [])).toEqual({ status: 'ready', value: 1 });
  });

  it('ready carries notices — healthy data with a caveat is NOT an error', () => {
    const notice = {
      kind: 'preload-truncated',
      message: 'Showing 4,000,000 of 9,000,000 points',
      loaded: 4_000_000,
      total: 9_000_000,
    } as const;

    const resolved = Resolution.ready('data', [notice]);

    expect(Resolution.isReady(resolved)).toBe(true);
    if (resolved.status !== 'ready') throw new Error('narrowing');
    expect(resolved.notices).toEqual([notice]);
  });

  it('failed carries the error, and may retain a stale value', () => {
    const error = anError();

    expect(Resolution.failed(error)).toEqual({ status: 'failed', error });
    expect(Resolution.failed(error, 'previous')).toEqual({
      status: 'failed',
      error,
      stale: 'previous',
    });
  });
});

describe('Resolution — accessors', () => {
  it('readyValue is settled-only: a stale value is not a ready value', () => {
    expect(Resolution.readyValue(Resolution.loading({ stale: 'old' }))).toBeUndefined();
    expect(Resolution.readyValue(Resolution.failed(anError(), 'old'))).toBeUndefined();
    expect(Resolution.readyValue(Resolution.ready('new'))).toBe('new');
  });

  it('lastGood keeps drawing across a refine, and across a failure that retains stale', () => {
    expect(Resolution.lastGood(Resolution.ready('new'))).toBe('new');
    expect(Resolution.lastGood(Resolution.loading({ stale: 'old' }))).toBe('old');
    expect(Resolution.lastGood(Resolution.failed(anError(), 'old'))).toBe('old');
  });

  it('lastGood is undefined when stale was NOT retained — callers must handle this', () => {
    // "stale is a retention, not a guarantee." A previously-ready resource may
    // become undrawable; the UI shows the Spatial Entry Error instead.
    expect(Resolution.lastGood(Resolution.failed(anError()))).toBeUndefined();
    expect(Resolution.lastGood(Resolution.loading<string>())).toBeUndefined();
  });

  it('keeps partial and lastGood SEPARATE — the render path draws both at once', () => {
    // Points draws lastGood as the base layer and partial as an overlay sub-layer.
    // Any helper collapsing these two would destroy that distinction, which is why
    // there is deliberately no `Resolution.valueOf()`.
    const scanning = Resolution.loading({ partial: 'growing', stale: 'old' });

    expect(Resolution.lastGood(scanning)).toBe('old');
    expect(Resolution.partialValue(scanning)).toBe('growing');
  });

  it('partialValue is loading-only', () => {
    expect(Resolution.partialValue(Resolution.ready('v'))).toBeUndefined();
    expect(Resolution.partialValue(Resolution.failed(anError()))).toBeUndefined();
  });

  it('guards narrow', () => {
    const r: Resolution<number> = Resolution.ready(1);
    expect(Resolution.isReady(r)).toBe(true);
    expect(Resolution.isIdle(r)).toBe(false);
    expect(Resolution.isLoading(r)).toBe(false);
    expect(Resolution.isFailed(r)).toBe(false);
  });
});

describe('fromResult', () => {
  // This is why Resolution lives in core: the Result it lifts is already here.
  it('lifts Ok into ready', () => {
    expect(fromResult(Ok(42), ctx)).toEqual({ status: 'ready', value: 42 });
  });

  it('lifts Err through the classifier — losslessly, for the one typed case', () => {
    const cause = new CoordinateSystemNotFoundError('aligned', 'cells', ['global']);

    const resolved = fromResult(Err(cause), ctx);

    expect(Resolution.isFailed(resolved)).toBe(true);
    if (resolved.status !== 'failed') throw new Error('narrowing');
    expect(resolved.error.kind).toBe('coordinate-system-not-found');
    expect(resolved.error.retryable).toBe(false);
  });
});
