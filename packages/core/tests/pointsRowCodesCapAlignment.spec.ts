import { Matrix4 } from '@math.gl/core';
import { describe, expect, it, vi } from 'vitest';
import {
  type PointsResolveConfig,
  PointsResolver,
  type ResolveContext,
} from '../src/engine/index.js';
import type { PointsElement } from '../src/models/index.js';
import type { PointsLoadResult } from '../src/pointsLoadOptions.js';

/**
 * R5 says the row codes are only a valid mask for the resident batch when both
 * were read at the SAME memory cap — index i names point i only then. The slot key
 * carries the cap so that misalignment is representable and therefore checkable.
 *
 * The planning gate did not check it. `hasRowFeatureCodes` is `isReady`, which
 * stays true after a cap raise, so codes settled at the old cap were never
 * re-requested and silently addressed the wrong rows of the bigger batch. This is
 * the R5 misalignment surviving in the one place that decides whether to fix it.
 *
 * Only reachable when the preload does NOT carry codes itself — a dict-only
 * element, whose codes come from the `loadRowFeatureCodes` fallback. When the
 * decode supplies them it re-settles them at its own cap for free.
 */

const SMALL_CAP = 4;
const LARGE_CAP = 8;
const TOTAL_ROWS = 8;

/** A dict-only preload: geometry, no `featureCodes`, truncated so a raise reloads. */
function codelessBatch(rows: number): PointsLoadResult {
  return {
    shape: [2, rows],
    data: [new Float32Array(rows), new Float32Array(rows)],
    hasFeatureCodeColumn: false,
    preloadTruncated: rows < TOTAL_ROWS,
    totalRowCount: TOTAL_ROWS,
  };
}

function dictOnlyElement() {
  return {
    key: 'transcripts',
    loadPoints: vi.fn(async ({ memoryCap }: { memoryCap: number }) =>
      codelessBatch(Math.min(TOTAL_ROWS, memoryCap))
    ),
    listFeaturesWithCounts: vi.fn(async () => null),
    // Row-aligned with whatever window it is asked for — the alignment contract.
    loadRowFeatureCodes: vi.fn(
      async ({ memoryCap }: { memoryCap: number }) =>
        new Int32Array(Math.min(TOTAL_ROWS, memoryCap))
    ),
    loadPointsMatchingFeatureCodes: vi.fn(async () => codelessBatch(1)),
  } as unknown as PointsElement;
}

// Tiling pinned off: `pointsTiling` defaults to `'auto'`, which defers the preload
// behind the probe. These tests are about rowCodes staying aligned with the resident
// batch, which only exists on the preloaded path.
const ctx = (
  el: PointsElement,
  config: PointsResolveConfig = {}
): ResolveContext<PointsResolveConfig, PointsElement> => ({
  entryId: 'layer-p',
  elementKey: 'transcripts',
  kind: 'points',
  element: el,
  // Merged, not defaulted: most callers pass a partial config, and a bare default
  // parameter would hand tiling back to its 'auto' production default for every one
  // of them.
  config: { pointsTiling: 'off', ...config },
  transform: new Matrix4(),
});

const signal = () => new AbortController().signal;

const rowCodesTasks = (resolver: PointsResolver, el: PointsElement, cap: number) =>
  resolver.plan(ctx(el, { pointsMemoryCap: cap })).filter((task) => task.resource === 'rowCodes');

describe('row codes — cap alignment with the resident batch', () => {
  it('re-plans the codes after a cap raise leaves them at the old window', async () => {
    const resolver = new PointsResolver();
    const el = dictOnlyElement();

    await resolver.load(
      { id: 'p', resource: 'preload', payload: { memoryCap: SMALL_CAP } },
      ctx(el),
      signal()
    );
    await resolver.load({ id: 'r', resource: 'rowCodes' }, ctx(el), signal());

    expect(resolver.getRowFeatureCodes('transcripts')?.length).toBe(SMALL_CAP);
    expect(resolver.hasRowFeatureCodesAtCap('transcripts', SMALL_CAP)).toBe(true);
    // Aligned at the resident cap: nothing to do.
    expect(rowCodesTasks(resolver, el, SMALL_CAP)).toEqual([]);

    // Raise the cap and let the bigger preload settle. The codes are now a 4-row
    // mask over an 8-row batch.
    await resolver.load(
      { id: 'p2', resource: 'preload', payload: { memoryCap: LARGE_CAP } },
      ctx(el),
      signal()
    );
    expect(resolver.getData('transcripts')?.shape[1]).toBe(LARGE_CAP);
    expect(resolver.hasRowFeatureCodesAtCap('transcripts', LARGE_CAP)).toBe(false);

    // The gate must notice. `hasRowFeatureCodes` is still true, which is exactly
    // why it could not be the gate.
    expect(resolver.hasRowFeatureCodes('transcripts')).toBe(true);
    const tasks = rowCodesTasks(resolver, el, LARGE_CAP);
    expect(tasks).toHaveLength(1);
    // The cap is in the id, so a cap change re-dispatches instead of deduping
    // against the task that already ran at the smaller window.
    expect(tasks[0]?.id).toContain(String(LARGE_CAP));

    await resolver.load(tasks[0] as never, ctx(el, { pointsMemoryCap: LARGE_CAP }), signal());
    expect(resolver.getRowFeatureCodes('transcripts')?.length).toBe(LARGE_CAP);
    expect(rowCodesTasks(resolver, el, LARGE_CAP)).toEqual([]);
  });

  it('waits for an in-flight preload rather than racing it for the same column', async () => {
    const resolver = new PointsResolver();
    const el = dictOnlyElement();

    await resolver.load(
      { id: 'p', resource: 'preload', payload: { memoryCap: SMALL_CAP } },
      ctx(el),
      signal()
    );
    await resolver.load({ id: 'r', resource: 'rowCodes' }, ctx(el), signal());
    const readsBefore = (el.loadRowFeatureCodes as ReturnType<typeof vi.fn>).mock.calls.length;

    // Start the larger preload WITHOUT awaiting it.
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    (el.loadPoints as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      await gate;
      return codelessBatch(LARGE_CAP);
    });
    const inFlight = resolver.load(
      { id: 'p2', resource: 'preload', payload: { memoryCap: LARGE_CAP } },
      ctx(el),
      signal()
    );

    // Codes are stale, but the decode may be about to supply them at the new cap.
    // Asking now would read the whole feature column a second time in parallel.
    expect(rowCodesTasks(resolver, el, LARGE_CAP)).toEqual([]);

    release();
    await inFlight;
    expect((el.loadRowFeatureCodes as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      readsBefore
    );
    // It did NOT supply them (dict-only), so now the gate asks.
    expect(rowCodesTasks(resolver, el, LARGE_CAP)).toHaveLength(1);
  });

  it('still plans the codes on a first load, while the preload is in flight', async () => {
    // The defer above is only for codes that already exist at a stale cap. With no
    // codes at all there is nothing to lose by asking, and waiting would delay
    // colour on every cold load.
    const resolver = new PointsResolver();
    const el = dictOnlyElement();
    (el.loadPoints as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<never>(() => {})
    );
    void resolver.load(
      { id: 'p', resource: 'preload', payload: { memoryCap: SMALL_CAP } },
      ctx(el),
      signal()
    );

    expect(rowCodesTasks(resolver, el, SMALL_CAP)).toHaveLength(1);
  });
});
