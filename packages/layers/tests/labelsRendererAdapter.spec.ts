import type { AssociatedTableFeatureRows } from '@spatialdata/core';
import { describe, expect, it } from 'vitest';
import {
  buildLabelFillColorEntry,
  type LabelFillColorEntry,
  type LabelsProjectionConfig,
  LabelsRendererAdapter,
} from '../src/adapters/LabelsRendererAdapter';

/**
 * The labels Renderer Adapter's identity contract.
 *
 * `LabelsLayer` decides whether to re-upload a potentially multi-megabyte GPU
 * texture by comparing the LUT it is handed **by identity**, and `getLayers()` runs
 * on every render — so a fresh object per render is a texture upload per frame.
 * These assert the observable consequence, not a cache-hit count.
 */

/** A small fixed palette, for tests whose subject is row alignment rather than
 *  colour choice — the default scheme is procedural, so colours must be pinned. */
const FIXED_PALETTE: [number, number, number][] = [
  [0, 0, 255],
  [0, 255, 0],
  [255, 0, 255],
];

const WHITE: [number, number, number] = [255, 255, 255];

const config = (over: LabelsProjectionConfig = {}): LabelsProjectionConfig => ({ ...over });

const rows = (column: string[]): AssociatedTableFeatureRows => ({
  rowIds: ['1', '2'],
  rowIndexByFeatureId: new Map([
    ['1', 0],
    ['2', 1],
  ]),
  extraColumns: [column],
});

describe('buildLabelFillColorEntry', () => {
  it('keys colours by label id from the associated table rows', () => {
    const entry = buildLabelFillColorEntry(
      config({
        fillColorByColumn: {
          columnName: 'cell_type',
          mode: 'categorical',
          categoricalPalette: FIXED_PALETTE,
        },
      }),
      rows(['tumour', 'stroma'])
    );

    expect(entry?.fillColorByFeatureId).toEqual({
      '1': [0, 255, 0, 255],
      '2': [0, 0, 255, 255],
    });
  });

  it('carries the configured scheme through to the colours', () => {
    const entry = buildLabelFillColorEntry(
      config({
        fillColorByColumn: {
          columnName: 'cell_type',
          mode: 'categorical',
          categoricalPalette: [
            [10, 20, 30],
            [40, 50, 60],
          ],
        },
      }),
      rows(['tumour', 'stroma'])
    );

    expect(entry?.fillColorByFeatureId).toEqual({
      '1': [40, 50, 60, 255],
      '2': [10, 20, 30, 255],
    });
  });

  it('invalidates the cache when only the scheme changes', () => {
    const base = { columnName: 'cell_type', mode: 'categorical' as const };
    const sameRows = rows(['tumour', 'stroma']);
    const a = buildLabelFillColorEntry(config({ fillColorByColumn: base }), sameRows);
    const b = buildLabelFillColorEntry(
      config({ fillColorByColumn: { ...base, categoricalPalette: FIXED_PALETTE } }),
      sameRows
    );
    // Same column, same rows — only the signature can tell these apart, and it must.
    expect(b?.signature).not.toBe(a?.signature);
  });

  it('produces nothing when no column is selected', () => {
    expect(buildLabelFillColorEntry(config(), rows(['tumour', 'stroma']))).toBeUndefined();
  });
});

describe('LabelsRendererAdapter.getColorLut', () => {
  const entry = (
    fillColorByFeatureId: Record<string, [number, number, number, number]>
  ): LabelFillColorEntry => ({
    // Same signature across entries: the column and mode did not change, only the
    // async-loaded rows (and so the entry identity) did.
    signature: 'cell_typecategorical',
    fillColorByFeatureId,
    rowsSource: {},
  });

  it('returns a stable identity while nothing changes', () => {
    const adapter = new LabelsRendererAdapter();
    const cfg = config({ featureState: { hiddenFeatureIds: ['2'] } });
    const a = adapter.getColorLut('layer-1', cfg, undefined, WHITE);
    const b = adapter.getColorLut('layer-1', cfg, undefined, WHITE);
    expect(b).toBe(a);
    expect(a?.colors[2 * 4 + 3]).toBe(0);
  });

  it('picks up new fill-colour data when the entry changes under an unchanged signature', () => {
    const adapter = new LabelsRendererAdapter();
    const cfg = config({ fillColorByColumn: { columnName: 'cell_type', mode: 'categorical' } });

    const stale = adapter.getColorLut('layer-1', cfg, entry({ '1': [10, 20, 30, 255] }), WHITE);
    expect(Array.from(stale?.colors.subarray(4, 8) ?? [])).toEqual([10, 20, 30, 255]);

    const fresh = adapter.getColorLut('layer-1', cfg, entry({ '1': [200, 100, 50, 255] }), WHITE);
    expect(Array.from(fresh?.colors.subarray(4, 8) ?? [])).toEqual([200, 100, 50, 255]);
  });

  it('rebuilds when the channel colour changes, since it is baked into the table', () => {
    const adapter = new LabelsRendererAdapter();
    const cfg = config({ featureState: { hiddenFeatureIds: ['2'] } });
    const white = adapter.getColorLut('layer-1', cfg, undefined, WHITE);
    const red = adapter.getColorLut('layer-1', cfg, undefined, [255, 0, 0]);
    expect(red).not.toBe(white);
    expect(Array.from(red?.colors.subarray(4, 8) ?? [])).toEqual([255, 0, 0, 255]);
  });

  it('lets an explicit per-label colour win over the table column', () => {
    const adapter = new LabelsRendererAdapter();
    const cfg = config({
      fillColorByColumn: { columnName: 'cell_type', mode: 'categorical' },
      featureState: { fillColorByFeatureId: { '1': [1, 2, 3, 255] } },
    });
    const lut = adapter.getColorLut('layer-1', cfg, entry({ '1': [10, 20, 30, 255] }), WHITE);
    expect(Array.from(lut?.colors.subarray(4, 8) ?? [])).toEqual([1, 2, 3, 255]);
  });

  it('has no table at all when the layer has no feature state', () => {
    const adapter = new LabelsRendererAdapter();
    expect(adapter.getColorLut('layer-1', config(), undefined, WHITE)).toBeUndefined();
  });

  it('keeps the explicit per-label colours while the column’s rows are pending', () => {
    // A selected column with no entry yet is a LOADING state, not an instruction to
    // clear: the caller's own colours must survive the window untouched.
    const adapter = new LabelsRendererAdapter();
    const cfg = config({
      fillColorByColumn: { columnName: 'cell_type', mode: 'categorical' },
      featureState: { fillColorByFeatureId: { '1': [1, 2, 3, 255] } },
    });

    const lut = adapter.getColorLut('layer-1', cfg, undefined, WHITE);

    expect(Array.from(lut?.colors.subarray(4, 8) ?? [])).toEqual([1, 2, 3, 255]);
  });

  it('keeps two layers colouring one element by different columns independent', () => {
    // Keying a LUT by element alone let two such layers evict each other on every
    // plan — the ping-pong that never settles.
    const adapter = new LabelsRendererAdapter();
    const cfg = config({ fillColorByColumn: { columnName: 'cell_type', mode: 'categorical' } });
    const a = adapter.getColorLut('layer-a', cfg, entry({ '1': [1, 1, 1, 255] }), WHITE);
    const b = adapter.getColorLut('layer-b', cfg, entry({ '1': [2, 2, 2, 255] }), WHITE);
    expect(Array.from(a?.colors.subarray(4, 8) ?? [])).toEqual([1, 1, 1, 255]);
    expect(Array.from(b?.colors.subarray(4, 8) ?? [])).toEqual([2, 2, 2, 255]);
  });
});

describe('LabelsRendererAdapter.getFillColorEntry', () => {
  const cfg = config({ fillColorByColumn: { columnName: 'cell_type', mode: 'categorical' } });

  it('keeps serving the previous column’s colours across a column switch', () => {
    // The switch itself is the gap: rows are cached per element+column, so the newly
    // selected column has nothing until it settles. Serving the old entry is what
    // stops every label flashing back to its channel colour in between.
    const adapter = new LabelsRendererAdapter();
    const loaded = adapter.getFillColorEntry('layer-1', 'cells', cfg, rows(['tumour', 'stroma']));
    expect(loaded).toBeDefined();

    const served = adapter.getFillColorEntry('layer-1', 'cells', cfg, undefined);
    expect(served).toBe(loaded);
  });

  it('refuses an entry built against a different element (label ids collide)', () => {
    const adapter = new LabelsRendererAdapter();
    adapter.getFillColorEntry('layer-1', 'nuclei', cfg, rows(['tumour', 'stroma']));

    expect(adapter.getFillColorEntry('layer-1', 'cells', cfg, undefined)).toBeUndefined();
  });

  it('has nothing to serve before the first load', () => {
    const adapter = new LabelsRendererAdapter();
    expect(adapter.getFillColorEntry('layer-1', 'cells', cfg, undefined)).toBeUndefined();
  });

  it('rebuilds when the mode changes under unchanged rows', () => {
    const adapter = new LabelsRendererAdapter();
    const sameRows = rows(['1', '2']);
    const a = adapter.getFillColorEntry('layer-1', 'cells', cfg, sameRows);
    const b = adapter.getFillColorEntry(
      'layer-1',
      'cells',
      config({ fillColorByColumn: { columnName: 'cell_type', mode: 'continuous' } }),
      sameRows
    );
    expect(b).not.toBe(a);
  });

  it('forgets a layer’s projections on eviction', () => {
    const adapter = new LabelsRendererAdapter();
    adapter.getFillColorEntry('layer-1', 'cells', cfg, rows(['tumour', 'stroma']));
    adapter.evictLayer('layer-1');
    expect(adapter.getFillColorEntry('layer-1', 'cells', cfg, undefined)).toBeUndefined();
  });
});
