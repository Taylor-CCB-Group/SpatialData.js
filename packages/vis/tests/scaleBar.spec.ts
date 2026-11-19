import { CompositeLayer } from '@deck.gl/core';
import { LineLayer, TextLayer } from '@deck.gl/layers';
import { ScaleBarLayer } from '@hms-dbmi/viv';
import { describe, expect, it } from 'vitest';
import {
  coordinateSystemUnitFromTransforms,
  resolveScaleBarSize,
  type ScaleBarSize,
  scaleBarSizeForUnit,
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

describe('scaleBarSizeForUnit', () => {
  it('maps OME-NGFF length names to the symbols Viv reads', () => {
    expect(scaleBarSizeForUnit('micrometer')).toEqual({ size: 1, unit: 'µm' });
    expect(scaleBarSizeForUnit('nanometer')).toEqual({ size: 1, unit: 'nm' });
    expect(scaleBarSizeForUnit('millimeter')).toEqual({ size: 1, unit: 'mm' });
    expect(scaleBarSizeForUnit('meter')).toEqual({ size: 1, unit: 'm' });
    expect(scaleBarSizeForUnit('kilometer')).toEqual({ size: 1, unit: 'km' });
  });

  it('accepts symbols, reading u as µ', () => {
    expect(scaleBarSizeForUnit('µm')).toEqual({ size: 1, unit: 'µm' });
    expect(scaleBarSizeForUnit('um')).toEqual({ size: 1, unit: 'µm' });
    expect(scaleBarSizeForUnit('nm')).toEqual({ size: 1, unit: 'nm' });
  });

  it('gives non-SI lengths in metres', () => {
    expect(scaleBarSizeForUnit('angstrom')).toEqual({ size: 1e-10, unit: 'm' });
    expect(scaleBarSizeForUnit('inch')).toEqual({ size: 0.0254, unit: 'm' });
  });

  it('has no size for the placeholder, non-lengths or nothing', () => {
    for (const unit of ['unit', 'second', 'pixel', 'constructormeter', 'toString', '', undefined]) {
      expect(scaleBarSizeForUnit(unit)).toBeUndefined();
    }
  });
});

describe('coordinateSystemUnitFromTransforms', () => {
  it('reads the spatial output axes', () => {
    expect(coordinateSystemUnitFromTransforms([into('micrometer', 'micrometer')])).toBe(
      'micrometer'
    );
  });

  it('has no unit when every element uses the placeholder or none', () => {
    expect(coordinateSystemUnitFromTransforms([into('unit', 'unit'), into()])).toBeUndefined();
    expect(coordinateSystemUnitFromTransforms([{}])).toBeUndefined();
  });

  it('ignores elements without a length unit', () => {
    expect(coordinateSystemUnitFromTransforms([into('unit', 'unit'), into('µm', 'µm')])).toBe('µm');
  });

  it('has no unit when elements disagree', () => {
    expect(
      coordinateSystemUnitFromTransforms([into('micrometer', 'micrometer'), into('nanometer')])
    ).toBeUndefined();
  });
});

describe('resolveScaleBarSize', () => {
  it('uses the host-declared unit without metadata', () => {
    expect(resolveScaleBarSize(null, 'global', 'micrometer')).toEqual({ size: 1, unit: 'µm' });
    expect(resolveScaleBarSize(null, 'global')).toBeUndefined();
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
