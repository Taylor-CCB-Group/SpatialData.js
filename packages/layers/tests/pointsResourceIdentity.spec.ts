import type { PointsElement, PointsLoadProgress, PointsLoadResult } from '@spatialdata/core';
import { describe, expect, it, vi } from 'vitest';
import { PointsDataEngine } from '../src/engine/PointsDataEngine.js';

/**
 * Render-resource IDENTITY stability, for all three points resources.
 *
 * Why this file exists, separately from pointsDataEngine.spec.ts:
 *
 * `PointsDataEngine` exposes three render resources, and **all three memoise
 * lazily on read** — because today their only caller is React's render phase, via
 * `getLayers()`. Deck tears a layer down and rebuilds its batch when `data`
 * identity changes, so a resource that is rebuilt per call is a teardown per
 * frame: the pan flash.
 *
 * The existing 845-line spec pins exactly ONE of the three (the resident one).
 * Nothing guards `getMatchingResource` or `getMatchingPartialResource` — so a
 * pan-flash on the matched layer, or a teardown-per-frame on the streaming
 * partial overlay, would be invisible to every test in the repo.
 *
 * That matters now because the Resource Resolver work MOVES these memos: out of
 * lazy-on-read in `core`'s resolver, into eager-once in the Renderer Adapter's
 * `project()` in `layers` (ADR 0004 §4 — identity-stable memoisation is a deck
 * requirement, so it belongs on the renderer side). This file is the contract
 * that move must not break. It is written against the CURRENT engine so it is
 * green before the refactor and must stay green through it.
 *
 * Repeated getter calls with no intervening state change stand in for repeated
 * renders — a pan, a hover, a viewState tick. That is precisely how `getLayers()`
 * calls them.
 */

const batch = (pointCount: number, opts: { truncated?: boolean } = {}): PointsLoadResult => ({
  shape: [2, pointCount],
  data: [
    new Float32Array(Array.from({ length: pointCount }, (_, i) => i)),
    new Float32Array(Array.from({ length: pointCount }, (_, i) => i)),
  ],
  featureCodes: new Int32Array(Array.from({ length: pointCount }, (_, i) => i % 2)),
  ...(opts.truncated ? { preloadTruncated: true, totalRowCount: 1_000_000 } : {}),
});

/** Defer a promise so a load/scan can be held open across assertions. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Yield once before emitting progress, the way a real loader does.
 *
 * This is not incidental. `ensureMatchingFeaturesLoaded` assigns
 * `entry.matchingLoading` *after* it constructs the scan's async IIFE, and the
 * IIFE runs synchronously up to its first `await`. So a loader that fires
 * `onProgress` before ever yielding hits `PointsDataEngine.ts`'s
 * `if (!loading …) return` guard and has its first chunk silently dropped.
 *
 * Real loaders always do I/O first, so this is unreachable in production — but a
 * stub that emits synchronously is not modelling the real thing, and pretending
 * otherwise here would make these tests assert against a state the engine never
 * actually reaches.
 */
const yieldTick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('resident render resource — getResource', () => {
  it('is identity-stable across repeated reads (the pan-flash guard)', async () => {
    const engine = new PointsDataEngine();
    const element = {
      key: 'pts',
      loadPoints: vi.fn(async () => batch(3)),
    } as unknown as PointsElement;

    await engine.ensureLoaded({ key: 'pts', layerId: 'l', element });

    const first = engine.getResource(element, 'pts');
    expect(first).not.toBeNull();
    // Ten "renders". Deck must see one resource.
    for (let i = 0; i < 10; i++) {
      expect(engine.getResource(element, 'pts')).toBe(first);
    }
  });

  it('is null before data, and does not memoise the null', async () => {
    const engine = new PointsDataEngine();
    const element = {
      key: 'pts',
      loadPoints: vi.fn(async () => batch(3)),
    } as unknown as PointsElement;

    expect(engine.getResource(element, 'pts')).toBeNull();

    await engine.ensureLoaded({ key: 'pts', layerId: 'l', element });

    expect(engine.getResource(element, 'pts')).not.toBeNull();
  });

  it('CHANGES identity when the underlying batch changes — staleness is the other failure', async () => {
    // The memo must not be so sticky that a genuine reload is ignored. Both
    // directions are bugs: churn is a flash, staleness is a wrong render.
    const engine = new PointsDataEngine();
    const element = {
      key: 'pts',
      // Truncated → raising the cap fetches more rows and swaps the batch.
      loadPoints: vi.fn(async (o: { memoryCap?: number }) =>
        batch(o?.memoryCap === 8 ? 8 : 4, { truncated: true })
      ),
    } as unknown as PointsElement;

    await engine.ensureLoaded({ key: 'pts', layerId: 'l', element }, 4);
    const before = engine.getResource(element, 'pts');

    await engine.ensureLoaded({ key: 'pts', layerId: 'l', element }, 8);
    const after = engine.getResource(element, 'pts');

    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
  });
});

describe('matched render resource — getMatchingResource', () => {
  // Covered by NOTHING today. A flash here is a flash on the selected genes.
  const scanElement = (result: PointsLoadResult) =>
    ({
      key: 'pts',
      loadPoints: vi.fn(async () => batch(4)),
      loadPointsMatchingFeatureCodes: vi.fn(async () => result),
    }) as unknown as PointsElement;

  it('is identity-stable across repeated reads', async () => {
    const engine = new PointsDataEngine();
    const element = scanElement(batch(2));

    await engine.ensureLoaded({ key: 'pts', layerId: 'l', element });
    await engine.ensureMatchingFeaturesLoaded({ key: 'pts', layerId: 'l', element }, [0]);

    const first = engine.getMatchingResource(element, 'pts');
    expect(first).not.toBeNull();
    for (let i = 0; i < 10; i++) {
      expect(engine.getMatchingResource(element, 'pts')).toBe(first);
    }
  });

  it('is distinct from the resident resource — they are two layers, drawn together', async () => {
    const engine = new PointsDataEngine();
    const element = scanElement(batch(2));

    await engine.ensureLoaded({ key: 'pts', layerId: 'l', element });
    await engine.ensureMatchingFeaturesLoaded({ key: 'pts', layerId: 'l', element }, [0]);

    expect(engine.getMatchingResource(element, 'pts')).not.toBe(engine.getResource(element, 'pts'));
  });

  it('CHANGES identity when a new selection settles', async () => {
    const engine = new PointsDataEngine();
    const results = [batch(2), batch(3)];
    let call = 0;
    const element = {
      key: 'pts',
      loadPoints: vi.fn(async () => batch(4)),
      loadPointsMatchingFeatureCodes: vi.fn(async () => results[call++] as PointsLoadResult),
    } as unknown as PointsElement;
    const target = { key: 'pts', layerId: 'l', element };

    await engine.ensureLoaded(target);
    await engine.ensureMatchingFeaturesLoaded(target, [0]);
    const first = engine.getMatchingResource(element, 'pts');

    // A DIFFERENT selection, not covered by the first → a real rescan.
    await engine.ensureMatchingFeaturesLoaded(target, [1]);
    const second = engine.getMatchingResource(element, 'pts');

    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });

  it('returns null for an empty matched batch — the empty-lock guard', async () => {
    // A scan that matched no rows must NOT supersede the resident preview, or the
    // render locks to an empty batch with no way back.
    const engine = new PointsDataEngine();
    const element = scanElement(batch(0));

    await engine.ensureLoaded({ key: 'pts', layerId: 'l', element });
    await engine.ensureMatchingFeaturesLoaded({ key: 'pts', layerId: 'l', element }, [0]);

    expect(engine.getMatchingResource(element, 'pts')).toBeNull();
  });
});

describe('partial render resource — getMatchingPartialResource', () => {
  // Also covered by NOTHING today. This one is the streaming overlay: it is read
  // on EVERY frame while a multi-second scan runs, which is exactly when the user
  // is most likely to be panning. Churn here is the worst case in the file.
  it('is identity-stable across reads while the partial buffer is unchanged', async () => {
    const engine = new PointsDataEngine();
    const scan = deferred<PointsLoadResult>();
    const partial = batch(2);

    const element = {
      key: 'pts',
      loadPoints: vi.fn(async () => batch(4)),
      loadPointsMatchingFeatureCodes: vi.fn(
        async (o: { onProgress?: (p: PointsLoadProgress) => void }) => {
          await yieldTick();
          o.onProgress?.({ matchedRows: 2, scannedRows: 10, partialResult: partial });
          return scan.promise;
        }
      ),
    } as unknown as PointsElement;
    const target = { key: 'pts', layerId: 'l', element };

    await engine.ensureLoaded(target);
    const pending = engine.ensureMatchingFeaturesLoaded(target, [0]);
    await yieldTick();

    const first = engine.getMatchingPartialResource(element, 'pts');
    expect(first).not.toBeNull();
    // Ten frames of panning mid-scan. One resource.
    for (let i = 0; i < 10; i++) {
      expect(engine.getMatchingPartialResource(element, 'pts')).toBe(first);
    }

    scan.resolve(batch(2));
    await pending;
  });

  it('HOLDS identity when the scan grows the buffer, bumping a revision instead (D10)', async () => {
    const engine = new PointsDataEngine();
    const scan = deferred<PointsLoadResult>();
    const first = batch(2);
    const grown = batch(5);
    let emit!: (p: PointsLoadProgress) => void;

    const element = {
      key: 'pts',
      loadPoints: vi.fn(async () => batch(4)),
      loadPointsMatchingFeatureCodes: vi.fn(
        async (o: { onProgress?: (p: PointsLoadProgress) => void }) => {
          await yieldTick();
          emit = o.onProgress as (p: PointsLoadProgress) => void;
          emit({ matchedRows: 2, scannedRows: 10, partialResult: first });
          return scan.promise;
        }
      ),
    } as unknown as PointsElement;
    const target = { key: 'pts', layerId: 'l', element };

    await engine.ensureLoaded(target);
    const pending = engine.ensureMatchingFeaturesLoaded(target, [0]);
    await yieldTick();

    const atFirstChunk = engine.getMatchingPartialResource(element, 'pts');
    expect(atFirstChunk).not.toBeNull();
    const revisionBefore = engine.getMatchingPartialRevision('pts');

    // A new chunk grows the buffer. D10: the resource identity is held STABLE for the
    // scan (so PointsLayer does not tear the overlay down per chunk) and the revision
    // bumps instead — the composite re-reads the grown buffer on that prop change.
    emit({ matchedRows: 5, scannedRows: 30, partialResult: grown });
    const atSecondChunk = engine.getMatchingPartialResource(element, 'pts');

    expect(atSecondChunk).toBe(atFirstChunk); // SAME resource — no teardown
    expect(engine.getMatchingPartialRevision('pts')).toBe(revisionBefore + 1);

    // Stable across reads until the next growth.
    expect(engine.getMatchingPartialResource(element, 'pts')).toBe(atSecondChunk);
    expect(engine.getMatchingPartialRevision('pts')).toBe(revisionBefore + 1);

    scan.resolve(grown);
    await pending;
  });

  it('is null once the scan settles — the partial overlay is torn down exactly once', async () => {
    const engine = new PointsDataEngine();
    const element = {
      key: 'pts',
      loadPoints: vi.fn(async () => batch(4)),
      loadPointsMatchingFeatureCodes: vi.fn(
        async (o: { onProgress?: (p: PointsLoadProgress) => void }) => {
          await yieldTick();
          o.onProgress?.({ matchedRows: 2, scannedRows: 10, partialResult: batch(2) });
          return batch(2);
        }
      ),
    } as unknown as PointsElement;
    const target = { key: 'pts', layerId: 'l', element };

    await engine.ensureLoaded(target);
    await engine.ensureMatchingFeaturesLoaded(target, [0]);

    expect(engine.getMatchingPartialResource(element, 'pts')).toBeNull();
    expect(engine.getMatchingResource(element, 'pts')).not.toBeNull();
  });
});

describe('base render resource — getBaseResource (P2)', () => {
  // The base layer's "current best view" evolves resident → resident-filtered →
  // matched over an element's life. Each is a different batch; the old code drew
  // them from two different resources under one layer id, so every swap changed the
  // loader identity and PointsLayer hard-reset — the base flicker. getBaseResource
  // holds ONE identity per element and swaps the backing batch, bumping a revision.
  function makeElement(key: string) {
    return {
      key,
      loadPoints: vi.fn(async () => batch(4)),
    } as unknown as PointsElement;
  }

  it('holds identity across a resident↔matched batch swap, bumping the revision', () => {
    const engine = new PointsDataEngine();
    const element = makeElement('pts');
    const resident = batch(4);
    const matched = batch(2);

    const first = engine.getBaseResource(element, 'pts', resident);
    expect(first).not.toBeNull();
    expect(engine.getBaseRevision('pts')).toBe(0);

    // Same batch, repeated reads (pan frames) → same resource, no revision bump.
    expect(engine.getBaseResource(element, 'pts', resident)).toBe(first);
    expect(engine.getBaseRevision('pts')).toBe(0);

    // Swap to the matched batch (a scan settled and now covers) → SAME resource
    // identity (no teardown), revision bumped so PointsLayer re-reads.
    const afterSwap = engine.getBaseResource(element, 'pts', matched);
    expect(afterSwap).toBe(first);
    expect(engine.getBaseRevision('pts')).toBe(1);

    // Stable again until the next swap.
    expect(engine.getBaseResource(element, 'pts', matched)).toBe(first);
    expect(engine.getBaseRevision('pts')).toBe(1);
  });

  it('is null (and clears) when there is no batch', () => {
    const engine = new PointsDataEngine();
    const element = makeElement('pts');
    engine.getBaseResource(element, 'pts', batch(4));
    expect(engine.getBaseResource(element, 'pts', undefined)).toBeNull();
    // Rebuilt fresh afterwards (revision resets).
    expect(engine.getBaseResource(element, 'pts', batch(4))).not.toBeNull();
    expect(engine.getBaseRevision('pts')).toBe(0);
  });
});
