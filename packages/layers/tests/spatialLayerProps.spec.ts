import { describe, expect, it } from 'vitest';
import {
  SPATIAL_LAYER_PROPS_SCHEMA_VERSION,
  migrateSpatialLayerProps,
  spatialLayerPropsSchema,
  spatialShapesSublayerSchema,
} from '../src/spatialLayerProps';

describe('migrateSpatialLayerProps', () => {
  it('parses current version unchanged', () => {
    const input = {
      schemaVersion: SPATIAL_LAYER_PROPS_SCHEMA_VERSION,
      sublayers: [{ kind: 'image' as const, url: 'https://example.com/a.zarr' }],
    };
    const out = migrateSpatialLayerProps(input);
    expect(out.schemaVersion).toBe(SPATIAL_LAYER_PROPS_SCHEMA_VERSION);
    expect(out.sublayers).toHaveLength(1);
    expect(out.sublayers[0]).toMatchObject({ kind: 'image', url: 'https://example.com/a.zarr' });
  });

  it('migrates v0-shaped objects without schemaVersion', () => {
    const out = migrateSpatialLayerProps({
      viewMode: '3d',
      sublayers: [{ kind: 'scatter' }],
    });
    expect(out.schemaVersion).toBe(SPATIAL_LAYER_PROPS_SCHEMA_VERSION);
    expect(out.viewMode).toBe('3d');
    expect(out.sublayers[0]?.kind).toBe('scatter');
  });

  it('drops invalid sublayer entries', () => {
    const out = migrateSpatialLayerProps({
      sublayers: [{ kind: 'scatter' }, { foo: 'bar' }],
    });
    expect(out.sublayers).toHaveLength(1);
  });

  it('defaults empty unknown input', () => {
    const out = migrateSpatialLayerProps(null);
    expect(spatialLayerPropsSchema.safeParse(out).success).toBe(true);
    expect(out.sublayers).toEqual([]);
  });

  it('rejects shapes sublayer when stroke width min exceeds max', () => {
    const result = spatialShapesSublayerSchema.safeParse({
      kind: 'shapes',
      elementKey: 'cells',
      defaultStrokeWidthMinPixels: 5,
      defaultStrokeWidthMaxPixels: 1,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message.includes('must be <='))).toBe(
        true
      );
    }
  });

  it('parses shapes feature-state props', () => {
    const out = migrateSpatialLayerProps({
      schemaVersion: SPATIAL_LAYER_PROPS_SCHEMA_VERSION,
      sublayers: [
        {
          kind: 'shapes',
          elementKey: 'cells',
          defaultFillColor: [1, 2, 3, 4],
          defaultStrokeWidthUnits: 'common',
          defaultStrokeWidthMinPixels: 0,
          defaultStrokeWidthMaxPixels: 1,
          featureState: {
            fillColorByFeatureId: { 'cell-1': [5, 6, 7, 8] },
            hiddenFeatureIds: ['cell-2'],
            fadedFeatureIds: ['cell-3'],
            filteredOpacityMultiplier: 0.2,
          },
        },
      ],
    });
    expect(out.sublayers[0]).toMatchObject({
      kind: 'shapes',
      elementKey: 'cells',
      defaultFillColor: [1, 2, 3, 4],
      defaultStrokeWidthUnits: 'common',
      defaultStrokeWidthMinPixels: 0,
      defaultStrokeWidthMaxPixels: 1,
    });
  });
});
