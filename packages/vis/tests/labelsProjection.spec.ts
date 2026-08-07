import { describe, expect, it } from 'vitest';
import {
  buildLabelFillColorEntry,
  getStableLabelColorLut,
  type LabelColorLutEntry,
  type LabelFillColorEntry,
  lastGoodLabelFillColorEntry,
} from '../src/SpatialCanvas/labelsProjection';
import type { LabelsLayerConfig } from '../src/SpatialCanvas/types';

/** A small fixed palette, for tests whose subject is row alignment rather than
 *  colour choice — the default scheme is procedural, so colours must be pinned. */
const FIXED_PALETTE: [number, number, number][] = [
  [0, 0, 255],
  [0, 255, 0],
  [255, 0, 255],
];

/**
 * The labels LUT projection cache.
 *
 * The identity contract is what matters here: `getLayers` runs on every render, and
 * `LabelsLayer` decides whether to re-upload a potentially multi-megabyte texture by
 * comparing the LUT it is handed to the last one **by identity**. A fresh object per
 * render would mean a GPU upload per frame.
 */

const WHITE: [number, number, number] = [255, 255, 255];

const config = (over: Partial<LabelsLayerConfig> = {}): LabelsLayerConfig =>
  ({
    type: 'labels',
    id: 'labels:cells',
    elementKey: 'cells',
    visible: true,
    opacity: 1,
    ...over,
  }) as LabelsLayerConfig;

const rows = (column: unknown[]) => ({
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

describe('getStableLabelColorLut', () => {
  const cache = (): Map<string, LabelColorLutEntry> => new Map();

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
    const store = cache();
    const cfg = config({ featureState: { hiddenFeatureIds: ['2'] } });
    const a = getStableLabelColorLut('layer-1', cfg, undefined, WHITE, store);
    const b = getStableLabelColorLut('layer-1', cfg, undefined, WHITE, store);
    expect(b).toBe(a);
    expect(a?.colors[2 * 4 + 3]).toBe(0);
  });

  it('picks up new fill-colour data when the entry changes under an unchanged signature', () => {
    const store = cache();
    const cfg = config({ fillColorByColumn: { columnName: 'cell_type', mode: 'categorical' } });

    const stale = getStableLabelColorLut(
      'layer-1',
      cfg,
      entry({ '1': [10, 20, 30, 255] }),
      WHITE,
      store
    );
    expect(Array.from(stale?.colors.subarray(4, 8) ?? [])).toEqual([10, 20, 30, 255]);

    const fresh = getStableLabelColorLut(
      'layer-1',
      cfg,
      entry({ '1': [200, 100, 50, 255] }),
      WHITE,
      store
    );
    expect(Array.from(fresh?.colors.subarray(4, 8) ?? [])).toEqual([200, 100, 50, 255]);
  });

  it('rebuilds when the channel colour changes, since it is baked into the table', () => {
    const store = cache();
    const cfg = config({ featureState: { hiddenFeatureIds: ['2'] } });
    const white = getStableLabelColorLut('layer-1', cfg, undefined, WHITE, store);
    const red = getStableLabelColorLut('layer-1', cfg, undefined, [255, 0, 0], store);
    expect(red).not.toBe(white);
    expect(Array.from(red?.colors.subarray(4, 8) ?? [])).toEqual([255, 0, 0, 255]);
  });

  it('lets an explicit per-label colour win over the table column', () => {
    const store = cache();
    const cfg = config({
      fillColorByColumn: { columnName: 'cell_type', mode: 'categorical' },
      featureState: { fillColorByFeatureId: { '1': [1, 2, 3, 255] } },
    });
    const lut = getStableLabelColorLut(
      'layer-1',
      cfg,
      entry({ '1': [10, 20, 30, 255] }),
      WHITE,
      store
    );
    expect(Array.from(lut?.colors.subarray(4, 8) ?? [])).toEqual([1, 2, 3, 255]);
  });

  it('has no table at all when the layer has no feature state', () => {
    expect(getStableLabelColorLut('layer-1', config(), undefined, WHITE, cache())).toBeUndefined();
  });

  it('keeps the explicit per-label colours while the column’s rows are pending', () => {
    // A selected column with no entry yet is a LOADING state, not an instruction to
    // clear: the caller's own colours must survive the window untouched.
    const cfg = config({
      fillColorByColumn: { columnName: 'cell_type', mode: 'categorical' },
      featureState: { fillColorByFeatureId: { '1': [1, 2, 3, 255] } },
    });

    const lut = getStableLabelColorLut('layer-1', cfg, undefined, WHITE, cache());

    expect(Array.from(lut?.colors.subarray(4, 8) ?? [])).toEqual([1, 2, 3, 255]);
  });
});

describe('lastGoodLabelFillColorEntry', () => {
  const forElement = (elementKey: string): LabelFillColorEntry => ({
    signature: 'cell_typecategorical',
    fillColorByFeatureId: { '1': [10, 20, 30, 255] },
    rowsSource: {},
    elementKey,
  });

  it('keeps serving the previous column’s colours across a column switch', () => {
    // The switch itself is the gap: rows are cached per element+column, so the newly
    // selected column has nothing until it settles. Serving the old entry is what
    // stops every label flashing back to its channel colour in between.
    const served = lastGoodLabelFillColorEntry(forElement('cells'), 'cells');

    expect(served?.fillColorByFeatureId).toEqual({ '1': [10, 20, 30, 255] });
  });

  it('refuses an entry built against a different element (label ids collide)', () => {
    expect(lastGoodLabelFillColorEntry(forElement('nuclei'), 'cells')).toBeUndefined();
  });

  it('has nothing to serve before the first load', () => {
    expect(lastGoodLabelFillColorEntry(undefined, 'cells')).toBeUndefined();
  });
});
