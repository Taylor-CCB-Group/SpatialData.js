import { Matrix4 } from '@math.gl/core';
import { describe, expect, it, vi } from 'vitest';
import {
  type PointsResolveConfig,
  PointsResolver,
  type ResolveContext,
} from '../src/engine/index.js';
import type { PointsElement, PointsFeatureCatalog } from '../src/models/index.js';
import type { PointsLoadResult } from '../src/pointsLoadOptions.js';

/**
 * The resident preload and the full-dataset catalog scan both write the catalog
 * slot, and they run CONCURRENTLY: the panel kicks the full scan the moment it
 * mounts, while a multi-million-row preload is still streaming.
 *
 * That overlap is where a merfish element went wrong in two visible ways — the
 * feature list stuck on partial "≥" counts forever, and colours that no longer
 * matched the panel (hovering the most abundant gene lit a small unrelated
 * cluster). Both come from the same window, so they are pinned together.
 *
 * A dict-only element (no `feature_key` code column) is the case that matters:
 * its codes are app-assigned, so the preview and the full scan generally number
 * the same gene DIFFERENTLY, and the render's per-row codes only agree with the
 * panel while both come from the same catalog.
 */

/** Rows are gene A, B, A, B — stated once, in names, so the code space is explicit. */
const ROW_NAMES = ['A', 'B', 'A', 'B'] as const;

const PREVIEW_CATALOG: PointsFeatureCatalog = {
  featureKey: 'gene',
  entries: [
    { code: 0, name: 'A' },
    { code: 1, name: 'B' },
  ],
};

// The full scan walks rows in file order and assigns codes as it meets each gene,
// so the same genes come back numbered the other way round — with counts.
const FULL_CATALOG: PointsFeatureCatalog = {
  featureKey: 'gene',
  entries: [
    { code: 0, name: 'B', count: 2 },
    { code: 1, name: 'A', count: 2 },
  ],
};

function codesIn(catalog: PointsFeatureCatalog, names: readonly string[]): number[] {
  const byName = new Map(catalog.entries.map((entry) => [entry.name, entry.code]));
  return names.map((name) => byName.get(name) as number);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Let every already-queued microtask (and the timer turn behind it) run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness() {
  const fullScan = deferred<PointsFeatureCatalog>();
  const el = {
    key: 'transcripts',
    // Dict-only: `hasFeatureCodeColumn` is false, and the decode hands back BOTH the
    // per-row codes and the preview catalog they are expressed in.
    loadPoints: vi.fn(
      async (): Promise<PointsLoadResult> => ({
        shape: [2, ROW_NAMES.length],
        data: [new Float32Array(ROW_NAMES.length), new Float32Array(ROW_NAMES.length)],
        featureCodes: Int32Array.from(codesIn(PREVIEW_CATALOG, ROW_NAMES)),
        featureCatalog: PREVIEW_CATALOG,
        hasFeatureCodeColumn: false,
      })
    ),
    listFeaturesWithCounts: vi.fn(async () => fullScan.promise),
    loadRowFeatureCodes: vi.fn(async () => Int32Array.from(codesIn(PREVIEW_CATALOG, ROW_NAMES))),
  } as unknown as PointsElement;

  const resolver = new PointsResolver();
  const target = { key: 'transcripts', layerId: 'layer-p', element: el };
  const context: ResolveContext<PointsResolveConfig, PointsElement> = {
    entryId: 'layer-p',
    elementKey: 'transcripts',
    kind: 'points',
    element: el,
    config: {},
    transform: new Matrix4(),
  };
  return { el, resolver, target, context, fullScan };
}

describe('catalog scan vs. the preload that finishes underneath it', () => {
  it('keeps the full catalog when the preload settles its preview mid-scan', async () => {
    const { resolver, target, fullScan } = harness();

    // The panel mounts and asks for the full list; the preload is still running.
    const scan = resolver.ensureFeatureCatalog(target);
    // …and finishes first, carrying its instant resident-subset preview.
    await resolver.ensureLoaded(target, 1_000);
    fullScan.resolve(FULL_CATALOG);
    await scan;
    await flush();

    // The preview is a strict downgrade of a scan that is already in flight. Losing
    // the full result here is what left the panel on "sorted by count so far"
    // permanently — nothing re-requests the catalog, so only a panel remount recovered.
    expect(resolver.getFeatureCatalog('transcripts')).toEqual(FULL_CATALOG);
  });

  it('leaves row codes in the same code space as the catalog it reports', async () => {
    const { resolver, target, fullScan } = harness();

    const scan = resolver.ensureFeatureCatalog(target);
    await resolver.ensureLoaded(target, 1_000);
    fullScan.resolve(FULL_CATALOG);
    await scan;
    await flush();

    // The invariant the renderer depends on: row code i names the same gene the panel
    // shows for code i. Break it and every point is drawn in another gene's colour —
    // and the hover highlight lights an unrelated scatter of points.
    const catalog = resolver.getFeatureCatalog('transcripts');
    expect(catalog).not.toBeNull();
    const rowCodes = resolver.getRowFeatureCodes('transcripts');
    expect(rowCodes).toBeDefined();
    expect([...(rowCodes as ArrayLike<number> as Int32Array)]).toEqual(
      codesIn(catalog as PointsFeatureCatalog, ROW_NAMES)
    );
  });
});
