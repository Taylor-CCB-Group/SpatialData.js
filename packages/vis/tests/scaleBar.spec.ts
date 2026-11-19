import { CompositeLayer } from '@deck.gl/core';
import { LineLayer, TextLayer } from '@deck.gl/layers';
import { ScaleBarLayer } from '@hms-dbmi/viv';
import { ATTRS_KEY } from '@spatialdata/core';
import { describe, expect, it } from 'vitest';
import {
  coordinateSystemLengthFromTransforms,
  resolveScaleBarSize,
  type ScaleBarSize,
} from '../src/SpatialCanvas/scaleBar.js';
import { VivSpatialViewer } from '../src/SpatialCanvas/VivSpatialViewer.js';

function into(...units: (string | undefined)[]) {
  return {
    output: {
      axes: [
        { name: 'c', type: 'channel' },
        ...units.map((unit, i) => ({ name: 'yx'[i], type: 'space', unit })),
      ],
    },
  };
}

const MICROMETRE = { size: 1, unit: 'µm' };

describe('coordinateSystemLengthFromTransforms', () => {
  it('reads the spatial output axes', () => {
    expect(coordinateSystemLengthFromTransforms([into('micrometer', 'micrometer')])).toEqual(
      MICROMETRE
    );
  });

  it('has no length when every element uses the placeholder or none', () => {
    expect(coordinateSystemLengthFromTransforms([into('unit', 'unit'), into()])).toBeUndefined();
    expect(coordinateSystemLengthFromTransforms([{}])).toBeUndefined();
  });

  it('ignores elements without a length unit', () => {
    expect(coordinateSystemLengthFromTransforms([into('unit', 'unit'), into('µm', 'µm')])).toEqual(
      MICROMETRE
    );
  });

  it('treats aliases of one length as agreeing', () => {
    expect(
      coordinateSystemLengthFromTransforms([
        into('micrometer', 'micrometer'),
        into('µm', 'µm'),
        into('um'),
      ])
    ).toEqual(MICROMETRE);
  });

  it('has no length when elements disagree', () => {
    expect(
      coordinateSystemLengthFromTransforms([into('micrometer', 'micrometer'), into('nanometer')])
    ).toBeUndefined();
    expect(coordinateSystemLengthFromTransforms([into('µm'), into('nm')])).toBeUndefined();
  });
});

/** A shapes element whose transform into `global` is a uniform scale. */
const scaledInto = (scale: number, unit = 'unit') => ({
  getTransformation: () => ({
    ok: true as const,
    value: {
      output: { axes: [{ type: 'space', unit }] },
      toArray: () => [scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    },
  }),
});

/** The layout spatialdata-io's xenium and atera readers write: µm shapes scaled to pixels. */
function readerStore(rootAttrs: Record<string, unknown>, cellsScale = 1 / 0.2125, unit?: string) {
  return {
    rootStore: { tree: { [ATTRS_KEY]: rootAttrs } },
    shapes: { nuclei: scaledInto(1 / 0.2125, unit), cells: scaledInto(cellsScale, unit) },
  };
}

describe('resolveScaleBarSize', () => {
  it('uses the host-declared unit or size without metadata', () => {
    expect(resolveScaleBarSize(null, 'global', 'micrometer')).toEqual(MICROMETRE);
    expect(resolveScaleBarSize(null, 'global', { size: 0.2125, unit: 'micrometer' })).toEqual({
      size: 0.2125,
      unit: 'µm',
    });
    expect(resolveScaleBarSize(null, 'global', { size: 2, unit: 'inch' })).toEqual({
      size: 0.0508,
      unit: 'm',
    });
    expect(resolveScaleBarSize(null, 'global', { size: 0, unit: 'µm' })).toBeUndefined();
    expect(resolveScaleBarSize(null, 'global')).toBeUndefined();
  });

  it('reads µm per unit from the xenium and atera readers’ shapes scale', () => {
    for (const reader of ['xenium', 'atera']) {
      const size = resolveScaleBarSize(readerStore({ spatialdata_io_reader: reader }), 'global');
      expect(size?.unit).toBe('µm');
      expect(size?.size).toBeCloseTo(0.2125);
    }
  });

  it('assumes nothing for other readers or scales that disagree', () => {
    expect(resolveScaleBarSize(readerStore({}), 'global')).toBeUndefined();
    expect(
      resolveScaleBarSize(readerStore({ spatialdata_io_reader: 'visium_hd' }), 'global')
    ).toBeUndefined();
    expect(
      resolveScaleBarSize(readerStore({ spatialdata_io_reader: 'xenium' }, 2), 'global')
    ).toBeUndefined();
  });

  it('prefers declared axis units to the reader convention', () => {
    const sdata = readerStore({ spatialdata_io_reader: 'xenium' }, undefined, 'nanometer');
    expect(resolveScaleBarSize(sdata, 'global')).toEqual({ size: 1, unit: 'nm' });
  });
});

function renderScaleBar(scaleBar: ScaleBarSize | undefined, zoom: number) {
  const viewer = new VivSpatialViewer({
    vivLayerProps: [],
    width: 512,
    height: 512,
    viewState: { target: [0, 0], zoom },
    onViewStateChange: () => {},
    scaleBar,
  });
  const bar = viewer._renderLayers().find((layer) => layer instanceof ScaleBarLayer);
  if (!bar) return undefined;
  if (!(bar instanceof CompositeLayer)) throw new Error('expected a composite scale bar');
  const rendered = bar.renderLayers();
  const parts = Array.isArray(rendered) ? rendered.flat() : [rendered];
  const line = parts.find((part) => part instanceof LineLayer);
  const text = parts.find((part) => part instanceof TextLayer);
  if (!(line instanceof LineLayer) || !(text instanceof TextLayer)) {
    throw new Error('expected a scale bar line and label');
  }
  const [[[x0], [x1]]] = line.props.data;
  const [{ text: label }] = text.props.data;
  return { screenLength: x1 - x0, label };
}

describe('VivSpatialViewer scale bar', () => {
  it('draws one in the view’s units without any image layer', () => {
    // 5% of a 512px view at zoom 0 is 25.6µm, which snaps up to 50µm = 50px.
    expect(renderScaleBar({ size: 1, unit: 'µm' }, 0)).toEqual({
      screenLength: 50,
      label: '50µm',
    });
    // One view unit is 2px at zoom 1: 12.8µm snaps to 20µm = 40px.
    expect(renderScaleBar({ size: 1, unit: 'µm' }, 1)).toEqual({
      screenLength: 40,
      label: '20µm',
    });
  });

  it('draws none without a size', () => {
    expect(renderScaleBar(undefined, 0)).toBeUndefined();
  });
});
