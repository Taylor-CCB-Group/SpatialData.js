import type { ShapesRenderData } from '@spatialdata/core';
import { describe, expect, it } from 'vitest';
import {
  type ShapeFillColorEntry,
  type ShapesEntryProps,
  ShapesRendererAdapter,
} from '../src/adapters/ShapesRendererAdapter';

/**
 * The shapes Renderer Adapter's identity contract.
 *
 * `getLayers()` runs on every render, and deck tears a layer down when its `data`
 * identity changes — so what these assert is not "the cache was hit" but the
 * observable consequence: the same object comes back when nothing changed, and a
 * different one when the data behind it did.
 */

const config: ShapesEntryProps = {
  fillColorByColumn: { columnName: 'colY', mode: 'categorical' },
};

/**
 * Two entries with the SAME signature string — the column name/mode/alpha did not
 * change, only the async-loaded row data (and so the entry identity) did. This is
 * the "one column behind" shape: when the fill column changes, the resolver keeps
 * serving the previous column's rows until the new ones settle, so the entry is
 * first built from stale rows and cached under the new column's signature.
 */
const entry = (
  fillColorByFeatureId: Record<string, [number, number, number, number]>
): ShapeFillColorEntry => ({
  signature: 'colYcategorical180',
  fillColorByFeatureId,
  rowsSource: {},
  renderSource: undefined,
});

/** Circle geometry — the simplest representation that still exercises the prebuild. */
const renderData = (featureIds: string[]): ShapesRenderData => ({
  kind: 'wkb-parquet',
  geometryKind: 'circle',
  elementKey: 'cells',
  featureIds,
  circles: {
    positions: [
      new Float32Array(featureIds.map((_, i) => i)),
      new Float32Array(featureIds.map((_, i) => i)),
    ],
    radii: new Float32Array(featureIds.length).fill(1),
  },
  rowIndexByFeatureIndex: new Int32Array(featureIds.map((_, i) => i)),
});

describe('ShapesRendererAdapter.getFeatureStateRuntime', () => {
  it('picks up new fill-colour data when the entry changes under an unchanged signature', () => {
    const adapter = new ShapesRendererAdapter();

    const stale = adapter.getFeatureStateRuntime(
      'layer-1',
      config,
      entry({ f1: [10, 20, 30, 255] })
    );
    expect(stale.fillColorByFeatureId.get('f1')).toEqual([10, 20, 30, 255]);

    // The newly-selected column's rows arrive — a NEW entry, same signature.
    const fresh = adapter.getFeatureStateRuntime(
      'layer-1',
      config,
      entry({ f1: [200, 100, 50, 255] })
    );
    expect(fresh.fillColorByFeatureId.get('f1')).toEqual([200, 100, 50, 255]);
  });

  it('returns a stable runtime identity when the entry is unchanged (no buffer thrash)', () => {
    const adapter = new ShapesRendererAdapter();
    const sameEntry = entry({ f1: [1, 2, 3, 255] });
    const a = adapter.getFeatureStateRuntime('layer-1', config, sameEntry);
    const b = adapter.getFeatureStateRuntime('layer-1', config, sameEntry);
    expect(b).toBe(a);
  });

  it('keeps two layers over one element independent', () => {
    // A single element may appear in several layer configs with different
    // encodings; a shared cache would let one layer's colours leak into the other.
    const adapter = new ShapesRendererAdapter();
    const a = adapter.getFeatureStateRuntime('layer-a', config, entry({ f1: [1, 1, 1, 255] }));
    const b = adapter.getFeatureStateRuntime('layer-b', config, entry({ f1: [2, 2, 2, 255] }));
    expect(a.fillColorByFeatureId.get('f1')).toEqual([1, 1, 1, 255]);
    expect(b.fillColorByFeatureId.get('f1')).toEqual([2, 2, 2, 255]);
  });

  it('leaves the caller’s per-feature colours alone while the column’s rows are pending', () => {
    // A selected column with no entry yet is a LOADING state, not an instruction to
    // clear. Overwriting `fillColorByFeatureId` with `{}` here wiped the caller's own
    // colours for the whole load window — the bug MDV had to work around.
    const adapter = new ShapesRendererAdapter();
    const runtime = adapter.getFeatureStateRuntime(
      'layer-1',
      { ...config, featureState: { fillColorByFeatureId: { f1: [9, 8, 7, 255] } } },
      undefined
    );

    expect(runtime.fillColorByFeatureId.get('f1')).toEqual([9, 8, 7, 255]);
  });
});

describe('ShapesRendererAdapter.getFillColorEntry', () => {
  const rows = (column: unknown[]) => ({
    rowIds: ['0', '1'],
    extraColumns: [column],
  });

  it('keeps serving the previous colours while the rows are unavailable', () => {
    const adapter = new ShapesRendererAdapter();
    const data = renderData(['f1', 'f2']);
    const loaded = adapter.getFillColorEntry(
      'layer-1',
      'cells',
      config,
      data,
      rows(['tumour', 'stroma'])
    );
    expect(loaded).toBeDefined();

    // Rows gone (a reload, or a failed load): the colours on screen must survive.
    const served = adapter.getFillColorEntry('layer-1', 'cells', config, data, undefined);
    expect(served).toBe(loaded);
  });

  it('refuses a cached entry built against a different element (feature ids do not carry)', () => {
    const adapter = new ShapesRendererAdapter();
    const data = renderData(['f1', 'f2']);
    adapter.getFillColorEntry('layer-1', 'nuclei', config, data, rows(['tumour', 'stroma']));

    // Same layer id, different element — feature ids are unique only within an
    // element, so the old entry would paint the wrong shapes.
    expect(adapter.getFillColorEntry('layer-1', 'cells', config, data, undefined)).toBeUndefined();
  });

  it('has nothing to serve before the first load', () => {
    const adapter = new ShapesRendererAdapter();
    expect(
      adapter.getFillColorEntry('layer-1', 'cells', config, renderData(['f1']), undefined)
    ).toBeUndefined();
  });

  it('produces nothing, and forgets any entry, when no column is selected', () => {
    const adapter = new ShapesRendererAdapter();
    const data = renderData(['f1', 'f2']);
    adapter.getFillColorEntry('layer-1', 'cells', config, data, rows(['tumour', 'stroma']));

    expect(adapter.getFillColorEntry('layer-1', 'cells', {}, data, undefined)).toBeUndefined();
    // …and the dropped entry is not resurrected as "last good" afterwards.
    expect(adapter.getFillColorEntry('layer-1', 'cells', config, data, undefined)).toBeUndefined();
  });
});

describe('ShapesRendererAdapter.getRenderData', () => {
  const tooltipRowIndices = new Int32Array([5, 6]);

  it('passes the raw identity straight through when there is nothing to patch', () => {
    const adapter = new ShapesRendererAdapter();
    const raw = renderData(['f1', 'f2']);
    expect(adapter.getRenderData('cells', raw, undefined)).toBe(raw);
  });

  it('holds the merged identity stable across calls (deck would read a change as a teardown)', () => {
    const adapter = new ShapesRendererAdapter();
    const raw = renderData(['f1', 'f2']);
    const a = adapter.getRenderData('cells', raw, tooltipRowIndices);
    const b = adapter.getRenderData('cells', raw, tooltipRowIndices);
    expect(b).toBe(a);
    expect(a.rowIndexByFeatureIndex).toBe(tooltipRowIndices);
  });

  it('re-merges when the tooltip rows land', () => {
    const adapter = new ShapesRendererAdapter();
    const raw = renderData(['f1', 'f2']);
    const before = adapter.getRenderData('cells', raw, undefined);
    const after = adapter.getRenderData('cells', raw, tooltipRowIndices);
    expect(after).not.toBe(before);
    expect(after.rowIndexByFeatureIndex).toBe(tooltipRowIndices);
  });
});

describe('ShapesRendererAdapter.getPrebuilt', () => {
  it('rebuilds on a hidden-id change but not on a bare re-render', () => {
    const adapter = new ShapesRendererAdapter();
    const data = renderData(['f1', 'f2']);

    const a = adapter.getPrebuilt('layer-1', data, undefined);
    expect(adapter.getPrebuilt('layer-1', data, undefined)).toBe(a);

    const hidden = adapter.getPrebuilt('layer-1', data, ['f1']);
    expect(hidden).not.toBe(a);
    expect(hidden.data).toHaveLength(1);
  });

  it('is unaffected by the order hidden ids are given in', () => {
    // The signature sorts them: a caller rebuilding the list per render must not
    // force an O(n-features) refilter.
    const adapter = new ShapesRendererAdapter();
    const data = renderData(['f1', 'f2', 'f3']);
    const a = adapter.getPrebuilt('layer-1', data, ['f1', 'f2']);
    expect(adapter.getPrebuilt('layer-1', data, ['f2', 'f1'])).toBe(a);
  });

  it('forgets a layer’s projections on eviction', () => {
    const adapter = new ShapesRendererAdapter();
    const data = renderData(['f1', 'f2']);
    const a = adapter.getPrebuilt('layer-1', data, undefined);
    adapter.evictLayer('layer-1');
    expect(adapter.getPrebuilt('layer-1', data, undefined)).not.toBe(a);
  });
});
