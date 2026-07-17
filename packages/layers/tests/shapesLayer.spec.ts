import { describe, expect, it, vi } from 'vitest';
import { SpatialLayer } from '../src/SpatialLayer';
import {
  buildShapeFeatureStateRuntime,
  buildShapesPrebuiltData,
  createShapesDeckLayer,
  deriveStrokeColor,
  featureFromBinary,
  DEFAULT_SHAPE_STROKE_WIDTH_MAX_PIXELS,
  DEFAULT_SHAPE_STROKE_WIDTH_MIN_PIXELS,
  DEFAULT_SHAPE_STROKE_WIDTH_UNITS,
  type GeoarrowTableLike,
  isShapeFeatureStateRuntime,
  normalizeShapeFeatureState,
  resolveShapeFeatureFromPick,
  resolveShapeTooltipFromPickInfo,
  resolveShapeTooltipRowIndex,
  type ShapesRenderDataLike,
} from '../src/shapesLayer';

const renderData: ShapesRenderDataLike = {
  kind: 'wkb-parquet',
  geometryKind: 'polygon',
  elementKey: 'cells',
  featureIds: ['cell-1', 'cell-2', 'cell-3'],
  polygons: [
    [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 0],
      ],
    ],
    [
      [
        [2, 2],
        [3, 2],
        [3, 3],
        [2, 2],
      ],
    ],
    [
      [
        [4, 4],
        [5, 4],
        [5, 5],
        [4, 4],
      ],
    ],
  ],
  rowIndexByFeatureIndex: new Int32Array([10, 11, 12]),
};

const geoarrowRenderData: ShapesRenderDataLike = {
  kind: 'geoarrow-table',
  geometryKind: 'polygon',
  elementKey: 'cells',
  featureIds: ['cell-1', 'cell-2'],
  geometryColumnName: 'geometry',
  geometryTable: {
    numRows: 2,
    getChild(name: string) {
      if (name !== 'geometry') {
        return undefined;
      }
      return {
        get(index: number) {
          return index === 0
            ? [
                [
                  [0, 0],
                  [1, 0],
                  [1, 1],
                  [0, 0],
                ],
              ]
            : [
                [
                  [2, 2],
                  [3, 2],
                  [3, 3],
                  [2, 2],
                ],
              ];
        },
      };
    },
  } satisfies GeoarrowTableLike,
  rowIndexByFeatureIndex: new Int32Array([20, 21]),
};

describe('shape feature state runtime', () => {
  it('reuses a pre-built runtime without reconverting records', () => {
    const runtime = buildShapeFeatureStateRuntime({
      fillColorByFeatureId: { a: [1, 2, 3, 255] },
      hiddenFeatureIds: ['b'],
    });
    expect(isShapeFeatureStateRuntime(runtime)).toBe(true);
    expect(buildShapeFeatureStateRuntime(runtime)).toBe(runtime);
    expect(normalizeShapeFeatureState(runtime)).toBe(runtime);
  });

  it('caches record conversion by plain-object identity', () => {
    const featureState = {
      fillColorByFeatureId: { 'cell-1': [1, 2, 3, 255] as [number, number, number, number] },
    };
    expect(normalizeShapeFeatureState(featureState)).toBe(normalizeShapeFeatureState(featureState));
  });
});

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
    expect((props.getFillColor as (d: any) => number[])(props.data[1])).toEqual([10, 20, 30, 128]);
    expect((props.getLineColor as (d: { featureId: string }) => number[])(props.data[0])).toEqual([
      4, 5, 6, 255,
    ]);
  });

  it('derives a lighter outline from the fill by default with zoom-scaled stroke defaults', () => {
    const layer = createShapesDeckLayer(
      renderData,
      {
        kind: 'shapes',
        elementKey: 'cells',
        visible: true,
        defaultFillColor: [10, 20, 30, 180],
        featureState: {
          fillColorByFeatureId: { 'cell-1': [1, 2, 3, 180] },
        },
      },
      { id: 'shapes-fill-stroke' }
    );

    if (!layer || Array.isArray(layer)) {
      throw new Error('Expected a single object-path shapes layer');
    }
    const props = layer.props as unknown as {
      data: Array<{ featureId: string }>;
      getLineColor: (datum: { featureId: string }) => number[];
      lineWidthUnits: string;
      lineWidthMinPixels: number;
      lineWidthMaxPixels: number;
      updateTriggers: {
        getFillColor: unknown[];
        getLineColor: unknown[];
        getLineWidth: unknown[];
      };
    };
    expect(props.lineWidthUnits).toBe(DEFAULT_SHAPE_STROKE_WIDTH_UNITS);
    expect(props.lineWidthMinPixels).toBe(DEFAULT_SHAPE_STROKE_WIDTH_MIN_PIXELS);
    expect(props.lineWidthMaxPixels).toBe(DEFAULT_SHAPE_STROKE_WIDTH_MAX_PIXELS);
    expect(props.updateTriggers.getFillColor).toHaveLength(5);
    expect(props.updateTriggers.getLineColor).toHaveLength(5);
    expect(props.updateTriggers.getFillColor[0]).toBeInstanceOf(Map);
    expect(props.updateTriggers.getLineWidth).toEqual([1]);
    // Outline = a lighter derivation of the fill, not the fill itself, so the
    // boundary is visible. cell-1 has a per-feature fill; cell-2 uses the default.
    expect(props.getLineColor(props.data[0])).toEqual(deriveStrokeColor([1, 2, 3, 180]));
    expect(props.getLineColor(props.data[1])).toEqual(deriveStrokeColor([10, 20, 30, 180]));
    // The derived outline is genuinely distinct from (lighter than) the fill.
    expect(props.getLineColor(props.data[0])).not.toEqual([1, 2, 3, 180]);
  });

  it('allows callers to configure polygon stroke width behavior', () => {
    const layer = createShapesDeckLayer(
      renderData,
      {
        kind: 'shapes',
        elementKey: 'cells',
        visible: true,
        defaultStrokeWidth: 3,
        defaultStrokeWidthUnits: 'pixels',
        defaultStrokeWidthMinPixels: 0.5,
        defaultStrokeWidthMaxPixels: 2,
      },
      { id: 'shapes-configured-stroke' }
    );

    if (!layer) {
      throw new Error('Expected shapes layer to render');
    }
    const props = layer.props as unknown as {
      getLineWidth: number;
      lineWidthUnits: string;
      lineWidthMinPixels: number;
      lineWidthMaxPixels: number;
    };
    expect(props.getLineWidth).toBe(3);
    expect(props.lineWidthUnits).toBe('pixels');
    expect(props.lineWidthMinPixels).toBe(0.5);
    expect(props.lineWidthMaxPixels).toBe(2);
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

  it('renders point landmarks with pixel-sized ScatterplotLayer markers', () => {
    const pointRenderData: ShapesRenderDataLike = {
      kind: 'wkb-parquet',
      geometryKind: 'point',
      elementKey: 'xenium_landmarks',
      featureIds: ['landmark-a'],
      circles: {
        positions: [new Float32Array([100]), new Float32Array([50])],
      },
      rowIndexByFeatureIndex: new Int32Array([0]),
    };

    const layer = createShapesDeckLayer(
      pointRenderData,
      {
        kind: 'shapes',
        elementKey: 'xenium_landmarks',
        visible: true,
      },
      { id: 'landmark-shapes' }
    );

    expect(layer).not.toBeNull();
    const props = layer!.props as any;
    expect(props.radiusUnits).toBe('pixels');
    expect((props.getRadius as (d: { radius: number }) => number)(props.data[0])).toBe(8);
  });

  it('renders circle shapes with ScatterplotLayer', () => {
    const circleRenderData: ShapesRenderDataLike = {
      kind: 'wkb-parquet',
      geometryKind: 'circle',
      elementKey: 'cell_circles',
      featureIds: ['cell-1', 'cell-2'],
      circles: {
        positions: [new Float32Array([0, 3]), new Float32Array([0, 3])],
        radii: new Float32Array([1, 2]),
      },
      rowIndexByFeatureIndex: new Int32Array([0, 1]),
    };

    const layer = createShapesDeckLayer(
      circleRenderData,
      {
        kind: 'shapes',
        elementKey: 'cell_circles',
        visible: true,
      },
      { id: 'circle-shapes' }
    );

    expect(layer).not.toBeNull();
    const props = layer!.props as any;
    expect(props.radiusUnits).toBe('common');
    expect(
      (props.data as Array<{ featureId: string; radius: number }>).map((d) => d.featureId)
    ).toEqual(['cell-1', 'cell-2']);
    expect((props.getRadius as (d: { radius: number }) => number)(props.data[1])).toBe(2);
  });

  it('renders geoarrow-table data through the shared backend branch', () => {
    const layer = createShapesDeckLayer(
      geoarrowRenderData,
      {
        kind: 'shapes',
        elementKey: 'cells',
        visible: true,
      },
      { id: 'geoarrow-shapes' }
    );

    expect(layer).not.toBeNull();
    const props = layer!.props as any;
    expect((props.data as Array<{ featureId: string }>).map((d) => d.featureId)).toEqual([
      'cell-1',
      'cell-2',
    ]);
  });

  it('resolves tooltip rows from the shared shape runtime data', () => {
    const layer = createShapesDeckLayer(
      renderData,
      {
        kind: 'shapes',
        elementKey: 'cells',
        visible: true,
      },
      { id: 'tooltip-shapes' }
    );
    const picked = (layer!.props.data as any[])[0];
    delete picked.rowIndex;

    expect(
      resolveShapeTooltipFromPickInfo(
        {
          tooltipFields: ['gene', 'score'],
          tooltipColumns: [
            ['a', 'b', 'c'],
            [1, 2, 3],
          ],
        },
        { object: picked },
        { rowIndexByFeatureIndex: new Int32Array([0, 1, 2]) }
      )
    ).toEqual({
      title: 'cell-1',
      items: [
        { label: 'gene', value: 'a' },
        { label: 'score', value: '1' },
      ],
    });
  });

  it('falls back to tooltipRowIndices when pick objects lack rowIndex', () => {
    const layer = createShapesDeckLayer(
      renderData,
      {
        kind: 'shapes',
        elementKey: 'cells',
        visible: true,
      },
      { id: 'tooltip-shapes-fallback' }
    );
    const picked = (layer!.props.data as any[])[0];
    delete picked.rowIndex;

    expect(
      resolveShapeTooltipFromPickInfo(
        {
          tooltipFields: ['gene'],
          tooltipColumns: [['a', 'b', 'c']],
        },
        { object: picked },
        { tooltipRowIndices: new Int32Array([0, 1, 2]) }
      )
    ).toEqual({
      title: 'cell-1',
      items: [{ label: 'gene', value: 'a' }],
    });
  });

  it('resolves circle tooltips by stable feature id', () => {
    const circleRenderData: ShapesRenderDataLike = {
      kind: 'wkb-parquet',
      geometryKind: 'circle',
      elementKey: 'cell_circles',
      featureIds: ['cell-1', 'cell-2'],
      circles: {
        positions: [new Float32Array([0, 3]), new Float32Array([0, 3])],
        radii: new Float32Array([1, 2]),
      },
      rowIndexByFeatureIndex: new Int32Array([-1, -1]),
    };
    const prebuilt = buildShapesPrebuiltData(circleRenderData);

    expect(
      resolveShapeTooltipFromPickInfo(
        {
          tooltipFields: ['area'],
          tooltipColumns: [['10.5', '20.5']],
        },
        { index: 0 },
        {
          tooltipRowIndexByFeatureId: new Map([
            ['cell-1', 0],
            ['cell-2', 1],
          ]),
        },
        prebuilt
      )
    ).toEqual({
      title: 'cell-1',
      items: [{ label: 'area', value: '10.5' }],
    });
  });

  it('prefers feature-index alignment over instance-key map when both are present', () => {
    expect(
      resolveShapeTooltipRowIndex(
        {
          featureId: '23816',
          featureIndex: 23816,
          rowIndex: 23816,
          polygon: renderData.polygons![0],
        },
        {
          tooltipRowIndexByFeatureId: new Map([['23816', 22271]]),
          rowIndexByFeatureIndex: new Int32Array(49750).fill(-1),
        }
      )
    ).toBe(23816);
  });

  it('prefers feature-id table lookup when feature-index alignment is unavailable', () => {
    expect(
      resolveShapeTooltipRowIndex(
        { featureId: 'cell-1', featureIndex: 5, polygon: renderData.polygons![0] },
        {
          tooltipRowIndexByFeatureId: new Map([['cell-1', 2]]),
          rowIndexByFeatureIndex: new Int32Array([0, 1, 2]),
        }
      )
    ).toBe(2);
  });

  it('falls back to prebuilt pick data when deck omits pick objects', () => {
    const prebuilt = buildShapesPrebuiltData(renderData);
    const feature = resolveShapeFeatureFromPick({ index: 1 }, prebuilt);
    expect(feature).toMatchObject({
      featureId: 'cell-2',
      featureIndex: 1,
    });
  });
});

describe('binary (flat-polygons) render path', () => {
  const binaryRenderData: ShapesRenderDataLike = {
    kind: 'flat-polygons',
    geometryKind: 'polygon',
    elementKey: 'cells',
    featureIds: ['cell-1', 'cell-2'],
    polygonBinary: {
      // Two triangles: feature 0 at the origin, feature 1 near (10,10).
      positions: new Float32Array([0, 0, 1, 0, 0, 1, 10, 10, 11, 10, 10, 11]),
      startIndices: new Int32Array([0, 3, 6]),
    },
    rowIndexByFeatureIndex: new Int32Array([5, 7]),
  };

  it('builds a binary prebuilt with no per-feature array', () => {
    const prebuilt = buildShapesPrebuiltData(binaryRenderData, ['cell-2']);
    expect(prebuilt.geometryKind).toBe('polygon');
    // Hidden features are NOT excluded from the binary buffer (index alignment).
    expect(prebuilt.data).toEqual([]);
    expect(prebuilt.binary?.featureIds).toEqual(['cell-1', 'cell-2']);
    expect(prebuilt.binary?.startIndices).toBe(binaryRenderData.polygonBinary?.startIndices);
  });

  it('renders a single vertex-pulling FlatPolygonLayer with topology + per-feature colour', () => {
    const prebuilt = buildShapesPrebuiltData(binaryRenderData);
    const layer = createShapesDeckLayer(
      binaryRenderData,
      {
        kind: 'shapes',
        elementKey: 'cells',
        visible: true,
        defaultFillColor: [10, 20, 30, 255],
        featureState: {
          fillColorByFeatureId: { 'cell-1': [1, 2, 3, 255] },
          hiddenFeatureIds: ['cell-2'],
        },
      },
      { id: 'shapes-binary' },
      prebuilt
    );

    // The binary path returns a single fill+outline FlatPolygonLayer; the shader pulls
    // position + edge-distance from the topology, so there are no vertex attributes.
    if (!Array.isArray(layer)) {
      throw new Error('Expected the binary path to return a single-layer array');
    }
    expect(layer).toHaveLength(1);
    const props = layer[0].props as any;

    // Two triangular rings → 2 triangles, 6 shared ring vertices. Topology packs the
    // feature index above the 3 boundary-flag bits; both triangles are all-boundary
    // (each ring is itself a triangle), so flags = 0b111 = 7.
    expect(props.triangleCount).toBe(2);
    expect(props.ringVertexCount).toBe(6);
    const td = props.triangleData as Uint32Array;
    expect(td[3] >>> 3).toBe(0); // triangle 0 → feature 0
    expect(td[3] & 7).toBe(7);
    expect(td[7] >>> 3).toBe(1); // triangle 1 → feature 1
    expect(td[7] & 7).toBe(7);

    // Colour is a per-FEATURE buffer (2 features → 8 bytes), sampled by index in the
    // shader — not expanded to vertices.
    expect(props.featureCount).toBe(2);
    const featureColors = props.featureColors as Uint8Array;
    expect(featureColors).toHaveLength(2 * 4);
    // Feature 0 (cell-1) → chosen fill colour; feature 1 (cell-2) hidden → transparent
    // (kept, not dropped; the shader discards it).
    expect(Array.from(featureColors.slice(0, 4))).toEqual([1, 2, 3, 255]);
    expect(Array.from(featureColors.slice(4, 8))).toEqual([0, 0, 0, 0]);
  });

  it('reconstructs a picked feature (and its ring) by index', () => {
    const prebuilt = buildShapesPrebuiltData(binaryRenderData);
    const feature = resolveShapeFeatureFromPick({ index: 1 }, prebuilt);
    expect(feature).toMatchObject({ featureId: 'cell-2', featureIndex: 1, rowIndex: 7 });
    expect((feature as { polygon: number[][][] }).polygon).toEqual([
      [
        [10, 10],
        [11, 10],
        [10, 11],
      ],
    ]);
    // Out-of-range index yields nothing rather than a bogus feature.
    expect(featureFromBinary(prebuilt.binary!, 99)).toBeUndefined();
  });

  it('keeps geometry topology + per-feature colour buffers stable across renders', () => {
    // The geometry textures are built from `triangleData`/`ringPositions`, whose
    // identities NEVER change with feature-state — they upload once. The per-feature
    // colour buffer is stable across bare re-renders (same runtime), so its texture is
    // rebuilt only on a real feature-state change, never on hover/pan.
    const featureState = normalizeShapeFeatureState(undefined); // EMPTY singleton
    const sublayer = { kind: 'shapes', elementKey: 'cells', visible: true, featureState } as const;
    const prebuilt = buildShapesPrebuiltData(binaryRenderData);

    const first = createShapesDeckLayer(binaryRenderData, sublayer, { id: 'x' }, prebuilt);
    const second = createShapesDeckLayer(binaryRenderData, sublayer, { id: 'x' }, prebuilt);
    if (!Array.isArray(first) || !Array.isArray(second)) {
      throw new Error('Expected the binary path to return a single-layer array');
    }

    // Stable topology buffer identities → geometry textures are not rebuilt.
    expect((second[0].props as any).triangleData).toBe((first[0].props as any).triangleData);
    expect((second[0].props as any).ringPositions).toBe((first[0].props as any).ringPositions);
    // Stable per-feature colour buffer identity → no colour texture rebuild.
    expect((second[0].props as any).featureColors).toBe((first[0].props as any).featureColors);
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

  it('keeps featureState semantics stable across backend choices', () => {
    const fallback = createShapesDeckLayer(
      renderData,
      {
        kind: 'shapes',
        elementKey: 'cells',
        visible: true,
        featureState: {
          hiddenFeatureIds: ['cell-2'],
        },
      },
      { id: 'fallback' }
    );
    const geoarrow = createShapesDeckLayer(
      {
        ...geoarrowRenderData,
        featureIds: ['cell-1', 'cell-2', 'cell-3'],
        rowIndexByFeatureIndex: new Int32Array([10, 11, 12]),
        geometryTable: {
          numRows: 3,
          getChild() {
            return {
              get(index: number) {
                return renderData.polygons?.[index];
              },
            };
          },
        },
      },
      {
        kind: 'shapes',
        elementKey: 'cells',
        visible: true,
        featureState: {
          hiddenFeatureIds: ['cell-2'],
        },
      },
      { id: 'geoarrow' }
    );

    expect((fallback!.props as any).data).toHaveLength(2);
    expect((geoarrow!.props as any).data).toHaveLength(2);
  });
});
