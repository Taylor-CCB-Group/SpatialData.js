import type { ShapeFeatureStateRuntime } from '@spatialdata/layers';
import { describe, expect, it } from 'vitest';
import {
  getStableShapeFeatureStateRuntime,
  type ShapeFillColorEntry,
} from '../src/SpatialCanvas/shapesProjection';
import type { ShapesLayerConfig } from '../src/SpatialCanvas/types';

/**
 * The fill-colour feature-state runtime cache.
 *
 * Regression for the "one column behind" bug: when the fill column changes, the
 * resolver keeps serving the *previous* column's rows until the new ones settle,
 * so the entry is first built from stale rows and cached under the new column's
 * signature. When the real rows arrive the entry's DATA updates but its
 * column-based signature does not — so the runtime cache must invalidate on the
 * entry's *identity*, not just its signature string, or it stays one behind.
 */

const config = {
  type: 'shapes',
  fillColorByColumn: { columnName: 'colY', mode: 'category' },
} as unknown as ShapesLayerConfig;

/** The cache shape `getStableShapeFeatureStateRuntime` requires. */
type RuntimeCache = Map<
  string,
  {
    signature: string;
    runtime: ShapeFeatureStateRuntime;
    fillColorEntry: ShapeFillColorEntry | undefined;
  }
>;

const entry = (
  fillColorByFeatureId: Record<string, [number, number, number, number]>
): ShapeFillColorEntry => ({
  // Same signature string across both entries — the column name/mode/alpha did not
  // change, only the async-loaded row data (and thus the entry identity) did.
  signature: 'colYcategory180',
  fillColorByFeatureId,
  rowsSource: {},
  renderSource: undefined,
});

describe('getStableShapeFeatureStateRuntime', () => {
  it('picks up new fill-colour data when the entry changes under an unchanged signature', () => {
    const cache: RuntimeCache = new Map();

    // First: entry built from the PREVIOUS column's still-loaded rows.
    const stale = getStableShapeFeatureStateRuntime(
      'layer-1',
      config,
      entry({ f1: [10, 20, 30, 255] }),
      cache
    );
    expect(stale.fillColorByFeatureId.get('f1')).toEqual([10, 20, 30, 255]);

    // Then: the newly-selected column's rows arrive — a NEW entry, same signature.
    const fresh = getStableShapeFeatureStateRuntime(
      'layer-1',
      config,
      entry({ f1: [200, 100, 50, 255] }),
      cache
    );
    // Must reflect the latest data, not the previous column's.
    expect(fresh.fillColorByFeatureId.get('f1')).toEqual([200, 100, 50, 255]);
  });

  it('returns a stable runtime identity when the entry is unchanged (no buffer thrash)', () => {
    const cache: RuntimeCache = new Map();
    const sameEntry = entry({ f1: [1, 2, 3, 255] });
    const a = getStableShapeFeatureStateRuntime('layer-1', config, sameEntry, cache);
    const b = getStableShapeFeatureStateRuntime('layer-1', config, sameEntry, cache);
    expect(b).toBe(a);
  });
});
