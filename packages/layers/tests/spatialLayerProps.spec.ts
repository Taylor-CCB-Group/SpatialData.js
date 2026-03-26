import { describe, expect, it } from 'vitest';
import {
  migrateSpatialLayerProps,
  SPATIAL_LAYER_PROPS_SCHEMA_VERSION,
  spatialLayerPropsSchema,
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
});
