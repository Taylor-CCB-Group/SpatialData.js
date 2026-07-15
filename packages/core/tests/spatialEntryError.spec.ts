import { describe, expect, it } from 'vitest';
import {
  isCancellation,
  type SpatialEntryErrorContext,
  toSpatialEntryError,
} from '../src/engine/index.js';
import { CoordinateSystemNotFoundError } from '../src/models/index.js';
import { PointsPreloadTooLargeError } from '../src/pointsLimits.js';

const ctx = (over: Partial<SpatialEntryErrorContext> = {}): SpatialEntryErrorContext => ({
  elementKey: 'transcripts',
  kind: 'points',
  resource: 'preload',
  fallback: 'load-failed',
  ...over,
});

describe('toSpatialEntryError — tier 1: instanceof (the only lossless tier)', () => {
  it('carries CoordinateSystemNotFoundError payload through, and is not retryable', () => {
    const cause = new CoordinateSystemNotFoundError('aligned', 'cells', ['global', 'micron']);

    const error = toSpatialEntryError(cause, ctx({ kind: 'shapes', resource: 'geometry' }));

    expect(error.kind).toBe('coordinate-system-not-found');
    expect(error.retryable).toBe(false);
    // The whole point of the typed tier: the UI can explain itself.
    if (error.kind !== 'coordinate-system-not-found') throw new Error('narrowing');
    expect(error.coordinateSystem).toBe('aligned');
    expect(error.elementKey).toBe('cells');
    expect(error.availableCoordinateSystems).toEqual(['global', 'micron']);
  });

  it('beats the fallback — a typed cause is never degraded to ctx.fallback', () => {
    const cause = new CoordinateSystemNotFoundError('aligned', 'cells', []);

    const error = toSpatialEntryError(cause, ctx({ fallback: 'decode-failed' }));

    expect(error.kind).toBe('coordinate-system-not-found');
  });

  it('carries PointsPreloadTooLargeError counts through', () => {
    const error = toSpatialEntryError(new PointsPreloadTooLargeError(9_000_000, 4_000_000), ctx());

    expect(error.kind).toBe('points-preload-too-large');
    expect(error.retryable).toBe(false);
    if (error.kind !== 'points-preload-too-large') throw new Error('narrowing');
    expect(error.rowCount).toBe(9_000_000);
    expect(error.maxRows).toBe(4_000_000);
  });
});

describe('toSpatialEntryError — tier 2: the one quarantined recogniser', () => {
  // worker-unavailable is thrown from inside seams whose fallback is decode-failed,
  // so context alone cannot reach it. This is the only sanctioned message-sniff.
  it('recognises worker-unavailable even when the seam nominated decode-failed', () => {
    const cause = new Error('readParquetRowGroup is unavailable');

    const error = toSpatialEntryError(cause, ctx({ fallback: 'decode-failed' }));

    expect(error.kind).toBe('worker-unavailable');
    expect(error.retryable).toBe(true);
  });

  it('recognises the points-worker variant of the same message', () => {
    const cause = new Error('parquet-wasm readParquetRowGroup is unavailable in points worker');

    expect(toSpatialEntryError(cause, ctx({ fallback: 'decode-failed' })).kind).toBe(
      'worker-unavailable'
    );
  });

  it('does not fire on an unrelated "unavailable"', () => {
    const cause = new Error('the network is unavailable');

    expect(toSpatialEntryError(cause, ctx({ fallback: 'decode-failed' })).kind).toBe(
      'decode-failed'
    );
  });
});

describe('toSpatialEntryError — tier 3: the seam decides', () => {
  // The load-bearing claim of this module: a bare `throw new Error(string)` carries
  // no type, and anything off the worker carries even less (its failure channel is
  // `{ ok: false; error: string }`). So the SEAM says what it was doing.
  it('classifies an untyped throw by ctx.fallback, not by its message', () => {
    const cause = new Error('something went wrong deep in a codec');

    expect(toSpatialEntryError(cause, ctx({ fallback: 'decode-failed' })).kind).toBe(
      'decode-failed'
    );
    expect(toSpatialEntryError(cause, ctx({ fallback: 'unsupported-format' })).kind).toBe(
      'unsupported-format'
    );
    expect(toSpatialEntryError(cause, ctx({ fallback: 'element-not-found' })).kind).toBe(
      'element-not-found'
    );
  });

  it('survives a non-Error throw', () => {
    const error = toSpatialEntryError('just a string', ctx({ fallback: 'load-failed' }));

    expect(error.kind).toBe('load-failed');
    expect(error.message).toBe('just a string');
  });

  it('preserves the cause for logs, and the resource for the message', () => {
    const cause = new Error('boom');

    const error = toSpatialEntryError(cause, ctx({ resource: 'tooltip', fallback: 'load-failed' }));

    expect(error.cause).toBe(cause);
    if (error.kind !== 'load-failed') throw new Error('narrowing');
    expect(error.resource).toBe('tooltip');
  });

  it('sets retryable per kind — this, not the union, is what enables Retry', () => {
    const cause = new Error('boom');

    expect(toSpatialEntryError(cause, ctx({ fallback: 'decode-failed' })).retryable).toBe(true);
    expect(toSpatialEntryError(cause, ctx({ fallback: 'worker-unavailable' })).retryable).toBe(
      true
    );
    expect(toSpatialEntryError(cause, ctx({ fallback: 'load-failed' })).retryable).toBe(true);
    // A missing element and a format we can't read will not fix themselves.
    expect(toSpatialEntryError(cause, ctx({ fallback: 'element-not-found' })).retryable).toBe(
      false
    );
    expect(toSpatialEntryError(cause, ctx({ fallback: 'unsupported-format' })).retryable).toBe(
      false
    );
  });
});

describe('isCancellation — the gate before the classifier', () => {
  // Cancellation is a non-event, not a domain failure: superseding a load is normal
  // operation. There is deliberately no `cancelled` case in SpatialEntryError, so
  // seams MUST check this first — otherwise every memory-cap drag paints an error.
  it('recognises a DOMException AbortError', () => {
    expect(isCancellation(new DOMException('Aborted', 'AbortError'))).toBe(true);
  });

  it('recognises an AbortError-shaped plain error', () => {
    const e = new Error('Aborted');
    e.name = 'AbortError';
    expect(isCancellation(e)).toBe(true);
  });

  it('recognises the signal an AbortController actually produces', () => {
    const controller = new AbortController();
    controller.abort();
    expect(isCancellation(controller.signal.reason)).toBe(true);
  });

  it('does not swallow a real failure', () => {
    expect(isCancellation(new Error('decode failed'))).toBe(false);
    expect(isCancellation('nope')).toBe(false);
    expect(isCancellation(undefined)).toBe(false);
    expect(isCancellation(null)).toBe(false);
  });
});
