import { describe, expect, it, vi } from 'vitest';

import { PointsDataEngine } from '../src/engine/PointsDataEngine.js';
import {
  DEFAULT_POINTS_MEMORY_CAP,
  type PointsElement,
  type PointsFeatureCatalog,
  type PointsLoadResult,
} from '@spatialdata/core';

function makeBatch(): PointsLoadResult {
  return {
    shape: [3, 2],
    data: [new Float32Array([0, 1, 2]), new Float32Array([0, 1, 2])],
  };
}

/** Minimal PointsElement stub: only `key` and `loadPoints` are exercised by the
 * preloaded path. `loadPoints` is a spy so we can assert idempotent loading. */
function makeElement(key: string, batch = makeBatch()) {
  const loadPoints = vi.fn(async () => batch);
  return { element: { key, loadPoints } as unknown as PointsElement, loadPoints };
}

const sampleCatalog: PointsFeatureCatalog = {
  featureKey: 'feature_name',
  entries: [
    { code: 0, name: 'GeneA', count: 10 },
    { code: 1, name: 'GeneB', count: 5 },
  ],
};

/** PointsElement stub covering the feature-filter surface. `catalog`/`rowCodes`
 * default to sensible values; pass `null`/`undefined` to model an element with
 * no `feature_key` or no codes. */
function makeFeatureElement(
  key: string,
  opts: {
    catalog?: PointsFeatureCatalog | null;
    rowCodes?: ArrayLike<number> | undefined;
  } = {}
) {
  // Use `in` checks, not destructuring defaults: an explicit `rowCodes: undefined`
  // (modeling an element with no codes) must NOT fall back to the sample array.
  const catalog = 'catalog' in opts ? opts.catalog : sampleCatalog;
  const rowCodes = 'rowCodes' in opts ? opts.rowCodes : new Int32Array([0, 1, 0]);
  const listFeaturesWithCounts = vi.fn(async () => catalog);
  const loadRowFeatureCodes = vi.fn(async () => rowCodes);
  const element = {
    key,
    loadPoints: vi.fn(async () => makeBatch()),
    listFeaturesWithCounts,
    loadRowFeatureCodes,
  } as unknown as PointsElement;
  return { element, listFeaturesWithCounts, loadRowFeatureCodes };
}

describe('PointsDataEngine', () => {
  it('loads once, reports status, and caches the batch', async () => {
    const statuses: Array<[string, string]> = [];
    const engine = new PointsDataEngine({
      onStatus: (layerId, status) => statuses.push([layerId, status]),
    });
    const { element } = makeElement('pts:a');

    expect(engine.hasData('pts:a')).toBe(false);
    expect(engine.getStatus('pts:a')).toBe('idle');

    await engine.ensureLoaded({ key: 'pts:a', layerId: 'layer-a', element });

    expect(engine.hasData('pts:a')).toBe(true);
    expect(engine.getStatus('pts:a')).toBe('ready');
    expect(engine.getData('pts:a')?.data[0]).toHaveLength(3);
    expect(statuses).toEqual([
      ['layer-a', 'loading'],
      ['layer-a', 'ready'],
    ]);
  });

  it('reloads at a new memory cap, passing it to loadPoints, and reports isLoadedWithCap', async () => {
    const engine = new PointsDataEngine();
    const loadPoints = vi.fn(async () => makeBatch());
    const element = { key: 'pts:cap', loadPoints } as unknown as PointsElement;

    await engine.ensureLoaded({ key: 'pts:cap', layerId: 'l', element }, 4_000_000);
    expect(engine.isLoadedWithCap('pts:cap', 4_000_000)).toBe(true);
    expect(engine.isLoadedWithCap('pts:cap', 8_000_000)).toBe(false);
    // Same cap again is a no-op.
    await engine.ensureLoaded({ key: 'pts:cap', layerId: 'l', element }, 4_000_000);
    expect(loadPoints).toHaveBeenCalledTimes(1);
    expect(loadPoints).toHaveBeenLastCalledWith(
      expect.objectContaining({ includeFeatureCodes: true, memoryCap: 4_000_000 })
    );

    // A different cap reloads.
    await engine.ensureLoaded({ key: 'pts:cap', layerId: 'l', element }, 8_000_000);
    expect(loadPoints).toHaveBeenCalledTimes(2);
    expect(loadPoints).toHaveBeenLastCalledWith(
      expect.objectContaining({ includeFeatureCodes: true, memoryCap: 8_000_000 })
    );
    expect(engine.isLoadedWithCap('pts:cap', 8_000_000)).toBe(true);
    expect(engine.isLoadedWithCap('pts:cap', 4_000_000)).toBe(false);
  });

  it('aborts the superseded preload when the memory cap changes', async () => {
    const engine = new PointsDataEngine();
    const signals: Array<AbortSignal | undefined> = [];
    const resolvers: Array<(v: PointsLoadResult) => void> = [];
    const loadPoints = vi.fn(
      (opts: { signal?: AbortSignal }) =>
        new Promise<PointsLoadResult>((resolve, reject) => {
          signals.push(opts.signal);
          resolvers.push(resolve);
          opts.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted.', 'AbortError'))
          );
        })
    );
    const element = { key: 'pts:abort', loadPoints } as unknown as PointsElement;

    const p1 = engine.ensureLoaded({ key: 'pts:abort', layerId: 'l', element }, 4_000_000);
    expect(signals[0]?.aborted).toBe(false);

    // A cap change supersedes the in-flight 4M load → its signal aborts.
    const p2 = engine.ensureLoaded({ key: 'pts:abort', layerId: 'l', element }, 8_000_000);
    expect(signals[0]?.aborted).toBe(true);

    // The aborted load rejects with AbortError; the engine swallows it (no error).
    await p1;
    expect(engine.getStatus('pts:abort')).not.toBe('error');

    // The current 8M load settles normally.
    resolvers[1](makeBatch());
    await p2;
    expect(engine.isLoadedWithCap('pts:abort', 8_000_000)).toBe(true);
  });

  it('defaults to DEFAULT_POINTS_MEMORY_CAP when no cap is given', async () => {
    const engine = new PointsDataEngine();
    const { element } = makeElement('pts:defcap');
    await engine.ensureLoaded({ key: 'pts:defcap', layerId: 'l', element });
    expect(engine.isLoadedWithCap('pts:defcap', DEFAULT_POINTS_MEMORY_CAP)).toBe(true);
  });

  it('preserves the full-dataset catalog across a cap change (no re-scan)', async () => {
    // A cap change reloads the resident geometry but must NOT drop the
    // (cap-independent, expensive) full-dataset catalog.
    const fullCatalog: PointsFeatureCatalog = {
      featureKey: 'feature_name',
      entries: [
        { code: 0, name: 'GeneA', count: 10 },
        { code: 1, name: 'GeneB', count: 5 },
        { code: 2, name: 'GeneC', count: 1 },
      ],
    };
    const listFeaturesWithCounts = vi.fn(async () => fullCatalog);
    const element = {
      key: 'pts:capcat',
      loadPoints: vi.fn(async () => makeBatch()),
      listFeaturesWithCounts,
    } as unknown as PointsElement;
    const engine = new PointsDataEngine();

    await engine.ensureLoaded({ key: 'pts:capcat', layerId: 'l', element }, 4_000_000);
    await engine.ensureFeatureCatalog({ key: 'pts:capcat', layerId: 'l', element });
    expect(engine.getFeatureCatalog('pts:capcat')).toEqual(fullCatalog);

    // Change the cap → geometry reloads, catalog stays (no second scan).
    await engine.ensureLoaded({ key: 'pts:capcat', layerId: 'l', element }, 8_000_000);
    expect(engine.getFeatureCatalog('pts:capcat')).toEqual(fullCatalog);
    expect(listFeaturesWithCounts).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: concurrent loads trigger a single loadPoints', async () => {
    const engine = new PointsDataEngine();
    const { element, loadPoints } = makeElement('pts:b');

    const p1 = engine.ensureLoaded({ key: 'pts:b', layerId: 'l', element });
    const p2 = engine.ensureLoaded({ key: 'pts:b', layerId: 'l', element });
    await Promise.all([p1, p2]);
    // A third call after settle is a no-op too.
    await engine.ensureLoaded({ key: 'pts:b', layerId: 'l', element });

    expect(loadPoints).toHaveBeenCalledTimes(1);
  });

  it('memoizes a stable render resource (the pan-flash guard)', async () => {
    const engine = new PointsDataEngine();
    const { element } = makeElement('pts:c');

    expect(engine.getResource(element, 'pts:c')).toBeNull(); // no data yet
    await engine.ensureLoaded({ key: 'pts:c', layerId: 'l', element });

    const r1 = engine.getResource(element, 'pts:c');
    const r2 = engine.getResource(element, 'pts:c');
    expect(r1).toBeTruthy();
    // Same identity across calls: a fresh loader each render would reset the
    // composite and blank the layer for a frame.
    expect(r1).toBe(r2);
    expect(r1?.loader).toBe(r2?.loader);
  });

  it('reports error status when loadPoints rejects', async () => {
    const statuses: string[] = [];
    const engine = new PointsDataEngine({ onStatus: (_l, s) => statuses.push(s) });
    const element = {
      key: 'pts:d',
      loadPoints: vi.fn(async () => {
        throw new Error('boom');
      }),
    } as unknown as PointsElement;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await engine.ensureLoaded({ key: 'pts:d', layerId: 'l', element });

    expect(engine.getStatus('pts:d')).toBe('error');
    expect(engine.hasData('pts:d')).toBe(false);
    expect(statuses).toEqual(['loading', 'error']);
    errSpy.mockRestore();
  });

  it('evict clears cached data and resource', async () => {
    const engine = new PointsDataEngine();
    const { element } = makeElement('pts:e');
    await engine.ensureLoaded({ key: 'pts:e', layerId: 'l', element });
    expect(engine.getResource(element, 'pts:e')).toBeTruthy();

    engine.evict('pts:e');

    expect(engine.hasData('pts:e')).toBe(false);
    expect(engine.getResource(element, 'pts:e')).toBeNull();
  });

  it('notifies subscribers when a load settles', async () => {
    const engine = new PointsDataEngine();
    const { element } = makeElement('pts:f');
    const listener = vi.fn();
    const unsubscribe = engine.subscribe(listener);

    await engine.ensureLoaded({ key: 'pts:f', layerId: 'l', element });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    engine.evict('pts:f');
    await engine.ensureLoaded({ key: 'pts:f', layerId: 'l', element });
    expect(listener).toHaveBeenCalledTimes(1); // no longer subscribed
  });
});

describe('PointsDataEngine — feature catalog', () => {
  it('builds the catalog once, reactively, and reports loading', async () => {
    const engine = new PointsDataEngine();
    const { element, listFeaturesWithCounts } = makeFeatureElement('pts:cat');
    const listener = vi.fn();
    engine.subscribe(listener);

    expect(engine.getFeatureCatalog('pts:cat')).toBeUndefined(); // not requested
    expect(engine.isFeatureCatalogLoading('pts:cat')).toBe(false);

    const p = engine.ensureFeatureCatalog({ key: 'pts:cat', layerId: 'l', element });
    expect(engine.isFeatureCatalogLoading('pts:cat')).toBe(true); // in flight
    await p;

    expect(engine.isFeatureCatalogLoading('pts:cat')).toBe(false);
    expect(engine.getFeatureCatalog('pts:cat')).toEqual(sampleCatalog);
    expect(listFeaturesWithCounts).toHaveBeenCalledTimes(1);
    // one notify for the loading transition, one for settle
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('is idempotent: concurrent + post-settle calls scan once', async () => {
    const engine = new PointsDataEngine();
    const { element, listFeaturesWithCounts } = makeFeatureElement('pts:cat2');

    await Promise.all([
      engine.ensureFeatureCatalog({ key: 'pts:cat2', layerId: 'l', element }),
      engine.ensureFeatureCatalog({ key: 'pts:cat2', layerId: 'l', element }),
    ]);
    await engine.ensureFeatureCatalog({ key: 'pts:cat2', layerId: 'l', element });

    expect(listFeaturesWithCounts).toHaveBeenCalledTimes(1);
  });

  it('settles to null for an element with no feature_key', async () => {
    const engine = new PointsDataEngine();
    const { element } = makeFeatureElement('pts:nofk', { catalog: null });

    await engine.ensureFeatureCatalog({ key: 'pts:nofk', layerId: 'l', element });

    // null (settled), distinct from undefined (not requested)
    expect(engine.getFeatureCatalog('pts:nofk')).toBeNull();
    expect(engine.getFeatureCatalog('pts:other')).toBeUndefined();
  });

  it('records null and stays settled when the scan rejects', async () => {
    const engine = new PointsDataEngine();
    const element = {
      key: 'pts:boom',
      listFeaturesWithCounts: vi.fn(async () => {
        throw new Error('scan failed');
      }),
    } as unknown as PointsElement;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await engine.ensureFeatureCatalog({ key: 'pts:boom', layerId: 'l', element });

    expect(engine.getFeatureCatalog('pts:boom')).toBeNull();
    expect(engine.isFeatureCatalogLoading('pts:boom')).toBe(false);
    errSpy.mockRestore();
  });
});

describe('PointsDataEngine — row feature codes', () => {
  it('loads codes aligned to the batch and passes the engine catalog', async () => {
    const engine = new PointsDataEngine();
    const { element, loadRowFeatureCodes } = makeFeatureElement('pts:rc');

    // Build the catalog first so the engine reuses it (no redundant core scan).
    await engine.ensureFeatureCatalog({ key: 'pts:rc', layerId: 'l', element });
    await engine.ensureRowFeatureCodes({ key: 'pts:rc', layerId: 'l', element });

    expect(engine.hasRowFeatureCodes('pts:rc')).toBe(true);
    expect(Array.from(engine.getRowFeatureCodes('pts:rc')!)).toEqual([0, 1, 0]);
    expect(loadRowFeatureCodes).toHaveBeenCalledWith({ featureCatalog: sampleCatalog });
  });

  it('passes undefined catalog when none is built yet (core scans internally)', async () => {
    const engine = new PointsDataEngine();
    const { element, loadRowFeatureCodes } = makeFeatureElement('pts:rc2');

    await engine.ensureRowFeatureCodes({ key: 'pts:rc2', layerId: 'l', element });

    expect(loadRowFeatureCodes).toHaveBeenCalledWith({ featureCatalog: undefined });
  });

  it('is idempotent', async () => {
    const engine = new PointsDataEngine();
    const { element, loadRowFeatureCodes } = makeFeatureElement('pts:rc3');

    await Promise.all([
      engine.ensureRowFeatureCodes({ key: 'pts:rc3', layerId: 'l', element }),
      engine.ensureRowFeatureCodes({ key: 'pts:rc3', layerId: 'l', element }),
    ]);
    await engine.ensureRowFeatureCodes({ key: 'pts:rc3', layerId: 'l', element });

    expect(loadRowFeatureCodes).toHaveBeenCalledTimes(1);
  });

  it('settles even when the element exposes no codes', async () => {
    const engine = new PointsDataEngine();
    const { element } = makeFeatureElement('pts:rc4', { rowCodes: undefined });

    await engine.ensureRowFeatureCodes({ key: 'pts:rc4', layerId: 'l', element });

    expect(engine.hasRowFeatureCodes('pts:rc4')).toBe(true);
    expect(engine.getRowFeatureCodes('pts:rc4')).toBeUndefined();
  });

  it('evict clears catalog and row codes with the batch', async () => {
    const engine = new PointsDataEngine();
    const { element } = makeFeatureElement('pts:rc5');
    await engine.ensureLoaded({ key: 'pts:rc5', layerId: 'l', element });
    await engine.ensureFeatureCatalog({ key: 'pts:rc5', layerId: 'l', element });
    await engine.ensureRowFeatureCodes({ key: 'pts:rc5', layerId: 'l', element });

    engine.evict('pts:rc5');

    expect(engine.hasData('pts:rc5')).toBe(false);
    expect(engine.getFeatureCatalog('pts:rc5')).toBeUndefined();
    expect(engine.hasRowFeatureCodes('pts:rc5')).toBe(false);
  });
});

describe('PointsDataEngine — codes with the geometry preload', () => {
  it('shows an instant preview catalog, then supersedes it with the full-dataset scan', async () => {
    // The geometry preload's catalog reflects only the resident batch (a
    // feature-ordered file's first part holds a slice of the features), so it is
    // an instant *preview*. The full-dataset scan supersedes it with the complete
    // list + counts. Row codes are complete for the resident batch, so their lazy
    // path stays a no-op.
    const previewCatalog = sampleCatalog;
    const fullCatalog = {
      ...sampleCatalog,
      entries: [
        ...sampleCatalog.entries,
        { code: 99, name: 'LATE_PART_GENE', count: 7 },
      ],
    };
    const loadPoints = vi.fn(async () => ({
      ...makeBatch(),
      featureCatalog: previewCatalog,
      featureCodes: new Int32Array([0, 1, 0]),
    }));
    const listFeaturesWithCounts = vi.fn(async () => fullCatalog);
    const loadRowFeatureCodes = vi.fn(async () => new Int32Array([0, 1, 0]));
    const element = {
      key: 'pts:res',
      loadPoints,
      listFeaturesWithCounts,
      loadRowFeatureCodes,
    } as unknown as PointsElement;
    const engine = new PointsDataEngine();

    await engine.ensureLoaded({ key: 'pts:res', layerId: 'l', element });

    // The preload requested the feature column: the preview catalog and the row
    // codes are resident with no separate file loads, and the preview shows
    // without a loading spinner.
    expect(loadPoints).toHaveBeenCalledWith(
      expect.objectContaining({
        includeFeatureCodes: true,
        memoryCap: DEFAULT_POINTS_MEMORY_CAP,
      })
    );
    expect(engine.getFeatureCatalog('pts:res')).toEqual(previewCatalog);
    expect(engine.hasRowFeatureCodes('pts:res')).toBe(true);
    expect(Array.from(engine.getRowFeatureCodes('pts:res')!)).toEqual([0, 1, 0]);
    expect(engine.isFeatureCatalogLoading('pts:res')).toBe(false);

    // The full-dataset catalog scan runs (even with a preview present) and
    // supersedes the preview; the row-code lazy path stays a no-op.
    await engine.ensureFeatureCatalog({ key: 'pts:res', layerId: 'l', element });
    await engine.ensureRowFeatureCodes({ key: 'pts:res', layerId: 'l', element });
    expect(listFeaturesWithCounts).toHaveBeenCalledTimes(1);
    expect(engine.getFeatureCatalog('pts:res')).toEqual(fullCatalog);
    expect(loadRowFeatureCodes).not.toHaveBeenCalled();

    // A second call is a no-op once the full scan has settled.
    await engine.ensureFeatureCatalog({ key: 'pts:res', layerId: 'l', element });
    expect(listFeaturesWithCounts).toHaveBeenCalledTimes(1);
  });

  it('remaps resident row codes into the full catalog space on upgrade (dict-only)', async () => {
    // Dictionary-only dataset: the resident preview saw GeneB first (code 0) and
    // GeneA second (code 1); the full-dataset scan assigns the reverse. Without
    // reconciliation, the render's per-row codes would be in the preview space
    // while the panel selects in the full space — filtering/colouring the wrong
    // genes. `hasFeatureCodeColumn: false` marks the codes as app-assigned.
    const previewCatalog: PointsFeatureCatalog = {
      featureKey: 'feature_name',
      entries: [
        { code: 0, name: 'GeneB' },
        { code: 1, name: 'GeneA' },
      ],
    };
    const fullCatalog: PointsFeatureCatalog = {
      featureKey: 'feature_name',
      entries: [
        { code: 0, name: 'GeneA' },
        { code: 1, name: 'GeneB' },
      ],
    };
    const element = {
      key: 'pts:remap',
      loadPoints: vi.fn(async () => ({
        ...makeBatch(),
        featureCatalog: previewCatalog,
        featureCodes: new Int32Array([0, 1, 0]), // GeneB, GeneA, GeneB (preview space)
        hasFeatureCodeColumn: false,
      })),
      listFeaturesWithCounts: vi.fn(async () => fullCatalog),
      loadRowFeatureCodes: vi.fn(),
    } as unknown as PointsElement;
    const engine = new PointsDataEngine();

    await engine.ensureLoaded({ key: 'pts:remap', layerId: 'l', element });
    // Before the upgrade, codes are in the preview space.
    expect(Array.from(engine.getRowFeatureCodes('pts:remap')!)).toEqual([0, 1, 0]);

    await engine.ensureFeatureCatalog({ key: 'pts:remap', layerId: 'l', element });
    // After the upgrade, the same genes are re-expressed in the full space:
    // GeneB→1, GeneA→0.
    expect(Array.from(engine.getRowFeatureCodes('pts:remap')!)).toEqual([1, 0, 1]);
    // The resident-codes memo reflects the remapped values.
    expect([...engine.getResidentFeatureCodes('pts:remap')!].sort()).toEqual([0, 1]);
  });

  it('does not remap when codes are authoritative (a real feature-code column)', async () => {
    // With a file-backed code column the codes are identical across catalog
    // builds, so reconciliation is skipped — the row-codes array keeps its
    // identity (no needless re-filter) and its values.
    const previewCatalog: PointsFeatureCatalog = {
      featureKey: 'feature_name',
      entries: [
        { code: 0, name: 'GeneA' },
        { code: 1, name: 'GeneB' },
      ],
    };
    const fullCatalog: PointsFeatureCatalog = {
      featureKey: 'feature_name',
      entries: [
        { code: 0, name: 'GeneA' },
        { code: 1, name: 'GeneB' },
        { code: 2, name: 'GeneC' },
      ],
    };
    const residentCodes = new Int32Array([0, 1, 0]);
    const element = {
      key: 'pts:auth',
      loadPoints: vi.fn(async () => ({
        ...makeBatch(),
        featureCatalog: previewCatalog,
        featureCodes: residentCodes,
        hasFeatureCodeColumn: true,
      })),
      listFeaturesWithCounts: vi.fn(async () => fullCatalog),
      loadRowFeatureCodes: vi.fn(),
    } as unknown as PointsElement;
    const engine = new PointsDataEngine();

    await engine.ensureLoaded({ key: 'pts:auth', layerId: 'l', element });
    await engine.ensureFeatureCatalog({ key: 'pts:auth', layerId: 'l', element });

    expect(engine.hasFeatureCodeColumn('pts:auth')).toBe(true);
    // Same array identity: authoritative codes are never rewritten.
    expect(engine.getRowFeatureCodes('pts:auth')).toBe(residentCodes);
  });

  it('reports the catalog as loading while the geometry preload is in flight', async () => {
    let resolveLoad: (v: unknown) => void = () => {};
    const loadPoints = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveLoad = resolve;
        })
    );
    const element = { key: 'pts:inflight', loadPoints } as unknown as PointsElement;
    const engine = new PointsDataEngine();

    const p = engine.ensureLoaded({ key: 'pts:inflight', layerId: 'l', element });
    // Geometry (which carries the catalog) is loading → catalog counts as loading.
    expect(engine.isFeatureCatalogLoading('pts:inflight')).toBe(true);
    expect(engine.getFeatureCatalog('pts:inflight')).toBeUndefined();

    resolveLoad({ ...makeBatch(), featureCatalog: sampleCatalog, featureCodes: new Int32Array([0]) });
    await p;
    expect(engine.isFeatureCatalogLoading('pts:inflight')).toBe(false);
    expect(engine.getFeatureCatalog('pts:inflight')).toEqual(sampleCatalog);
  });
});

describe('PointsDataEngine — hasFeatureCodeColumn', () => {
  it('defaults to false and reflects the resident load flag', async () => {
    const engine = new PointsDataEngine();
    expect(engine.hasFeatureCodeColumn('pts:unknown')).toBe(false); // never loaded

    const withColumn = {
      key: 'pts:hascol',
      loadPoints: vi.fn(async () => ({ ...makeBatch(), hasFeatureCodeColumn: true })),
    } as unknown as PointsElement;
    await engine.ensureLoaded({ key: 'pts:hascol', layerId: 'l', element: withColumn });
    expect(engine.hasFeatureCodeColumn('pts:hascol')).toBe(true);

    const dictOnly = {
      key: 'pts:dict',
      loadPoints: vi.fn(async () => ({ ...makeBatch(), hasFeatureCodeColumn: false })),
    } as unknown as PointsElement;
    await engine.ensureLoaded({ key: 'pts:dict', layerId: 'l', element: dictOnly });
    expect(engine.hasFeatureCodeColumn('pts:dict')).toBe(false);
  });
});

describe('PointsDataEngine — matching resource (empty-lock guard)', () => {
  function matchingElement(key: string, result: PointsLoadResult) {
    return {
      key,
      loadPoints: vi.fn(async () => makeBatch()),
      loadPointsMatchingFeatureCodes: vi.fn(async () => result),
    } as unknown as PointsElement;
  }

  it('returns null for a scan that matched no rows, so the view is never locked empty', async () => {
    const engine = new PointsDataEngine();
    // A degenerate scan settles with 0 matched rows (e.g. a selection whose codes
    // matched nothing). It must NOT supersede the resident preview.
    const element = matchingElement('pts:empty', {
      shape: [2, 0],
      data: [new Float32Array(0), new Float32Array(0)],
    });
    await engine.ensureMatchingFeaturesLoaded({ key: 'pts:empty', layerId: 'l', element }, [7]);

    expect(engine.getMatchingResource(element, 'pts:empty')).toBeNull();
  });

  it('returns a resource when the scan matched rows', async () => {
    const engine = new PointsDataEngine();
    const element = matchingElement('pts:hit', {
      shape: [2, 2],
      data: [new Float32Array([0, 1]), new Float32Array([0, 1])],
    });
    await engine.ensureMatchingFeaturesLoaded({ key: 'pts:hit', layerId: 'l', element }, [1]);

    expect(engine.getMatchingResource(element, 'pts:hit')).toBeTruthy();
  });
});

describe('PointsDataEngine — matched-selection subset reuse', () => {
  function scanElement(key: string) {
    const loadPointsMatchingFeatureCodes = vi.fn(async (opts: { featureCodes: readonly number[] }) => ({
      shape: [2, opts.featureCodes.length],
      data: [new Float32Array(opts.featureCodes.length), new Float32Array(opts.featureCodes.length)],
      // Per-row codes the render uses to filter the batch in memory.
      featureCodes: Int32Array.from(opts.featureCodes),
    }));
    const element = {
      key,
      loadPoints: vi.fn(async () => makeBatch()),
      loadPointsMatchingFeatureCodes,
    } as unknown as PointsElement;
    return { element, loadPointsMatchingFeatureCodes };
  }

  it('reuses the batch (no re-scan) when a feature is removed — the removal fast path', async () => {
    const engine = new PointsDataEngine();
    const { element, loadPointsMatchingFeatureCodes } = scanElement('pts:sub');
    const target = { key: 'pts:sub', layerId: 'l', element };

    await engine.ensureMatchingFeaturesLoaded(target, [1, 2, 3]);
    expect(loadPointsMatchingFeatureCodes).toHaveBeenCalledTimes(1);
    expect([...engine.getLoadedMatchingFeatureCodes('pts:sub')!].sort()).toEqual([1, 2, 3]);

    // Remove a feature → {1,2} ⊆ {1,2,3}: reuse the loaded batch, NO new scan.
    await engine.ensureMatchingFeaturesLoaded(target, [1, 2]);
    expect(loadPointsMatchingFeatureCodes).toHaveBeenCalledTimes(1);
    // The covered set stays {1,2,3}, so the removed feature is still in memory
    // (re-adding it is a free filter, and the panel keeps it un-greyed).
    expect([...engine.getLoadedMatchingFeatureCodes('pts:sub')!].sort()).toEqual([1, 2, 3]);
    // Per-row codes are exposed for the layer to filter the batch in memory.
    expect(engine.getMatchingRowFeatureCodes('pts:sub')).toBeInstanceOf(Int32Array);
    // The load-state reports the subset as settled+covered (served from memory),
    // so the panel indicator doesn't vanish on a removal.
    const state = engine.getMatchingLoadState('pts:sub', [1, 2]);
    expect(state).toMatchObject({ loading: false, settled: true, covered: true });
  });

  it('re-scans when the selection adds a code no loaded batch covers', async () => {
    const engine = new PointsDataEngine();
    const { element, loadPointsMatchingFeatureCodes } = scanElement('pts:add');
    const target = { key: 'pts:add', layerId: 'l', element };

    await engine.ensureMatchingFeaturesLoaded(target, [1, 2]);
    expect(loadPointsMatchingFeatureCodes).toHaveBeenCalledTimes(1);

    // Removing back to {1} reuses (no scan)…
    await engine.ensureMatchingFeaturesLoaded(target, [1]);
    expect(loadPointsMatchingFeatureCodes).toHaveBeenCalledTimes(1);

    // …but adding {3} (not covered) scans.
    await engine.ensureMatchingFeaturesLoaded(target, [1, 3]);
    expect(loadPointsMatchingFeatureCodes).toHaveBeenCalledTimes(2);
    expect([...engine.getLoadedMatchingFeatureCodes('pts:add')!].sort()).toEqual([1, 3]);
  });
});
