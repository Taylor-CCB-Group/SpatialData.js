import { describe, expect, it, vi } from 'vitest';
import { SpatialLayer } from '../src/SpatialLayer';
import { createShapesDeckLayer, type ShapesRenderDataLike } from '../src/shapesLayer';

const renderData: ShapesRenderDataLike = {
  kind: 'wkb-parquet',
  elementKey: 'cells',
  featureIds: ['cell-1', 'cell-2', 'cell-3'],
  polygons: [
    [[[0, 0], [1, 0], [1, 1], [0, 0]]],
    [[[2, 2], [3, 2], [3, 3], [2, 2]]],
    [[[4, 4], [5, 4], [5, 5], [4, 4]]],
  ],
  rowIndexByFeatureIndex: new Int32Array([10, 11, 12]),
};

describe('createShapesDeckLayer', () => {
  it('applies feature-state styling and filtering keyed by feature id', () => {
    const layer = createShapesDeckLayer(
      renderData,
      {
        kind: 'shapes',
        elementKey: 'cells',
        visible: true,
        defaultFillColor: [10, 20, 30, 255],
        defaultStrokeColor: [40, 50, 60, 255],
        featureState: {
          fillColorByFeatureId: { 'cell-1': [1, 2, 3, 255] },
          strokeColorByFeatureId: { 'cell-1': [4, 5, 6, 255] },
          hiddenFeatureIds: ['cell-2'],
          fadedFeatureIds: ['cell-3'],
          filteredOpacityMultiplier: 0.5,
        },
      },
      { id: 'shapes-test' }
    );

    expect(layer).not.toBeNull();
    const props = layer!.props as any;
    expect((props.data as unknown[]).length).toBe(2);
    expect((props.data as Array<{ featureId: string }>).map((d) => d.featureId)).toEqual([
      'cell-1',
      'cell-3',
    ]);
    expect((props.getFillColor as (d: any) => number[])(props.data[0])).toEqual([1, 2, 3, 255]);
    expect((props.getFillColor as (d: any) => number[])(props.data[1])).toEqual([
      10, 20, 30, 128,
    ]);
  });

  it('emits enriched pick callbacks', () => {
    const onShapeHover = vi.fn();
    const layer = createShapesDeckLayer(
      renderData,
      {
        kind: 'shapes',
        elementKey: 'cells',
        visible: true,
      },
      { id: 'shapes-test', spatialCoordinateSystem: 'global', onShapeHover }
    );

    const hovered = (layer!.props.data as any[])[0];
    (layer!.props.onHover as (info: any) => void)({ object: hovered });
    expect(onShapeHover).toHaveBeenCalledWith(
      expect.objectContaining({
        layerId: 'shapes-test',
        elementKey: 'cells',
        featureId: 'cell-1',
        featureIndex: 0,
        coordinateSystem: 'global',
        rowIndex: 10,
      })
    );
  });
});

describe('SpatialLayer', () => {
  it('builds a shapes layer from runtime render data', () => {
    const layer = new SpatialLayer({
      id: 'root',
      schemaVersion: 1,
      sublayers: [{ kind: 'shapes', elementKey: 'cells', visible: true }],
      shapeRenderData: { cells: renderData },
    });

    const rendered = layer.renderLayers();
    expect(Array.isArray(rendered)).toBe(true);
    expect(rendered as any[]).toHaveLength(1);
  });
});
