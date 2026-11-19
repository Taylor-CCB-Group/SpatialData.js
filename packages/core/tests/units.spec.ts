import { describe, expect, it } from 'vitest';
import { ATTRS_KEY, type ConsolidatedStore } from 'zarrextra';
import { describeElementIssue } from '../src/issues.js';
import { SpatialData } from '../src/store/index.js';
import { physicalLengthOfUnit } from '../src/units.js';

describe('physicalLengthOfUnit', () => {
  it('maps OME-NGFF length names to SI symbols', () => {
    expect(physicalLengthOfUnit('micrometer')).toEqual({ size: 1, unit: 'µm' });
    expect(physicalLengthOfUnit('nanometer')).toEqual({ size: 1, unit: 'nm' });
    expect(physicalLengthOfUnit('millimeter')).toEqual({ size: 1, unit: 'mm' });
    expect(physicalLengthOfUnit('meter')).toEqual({ size: 1, unit: 'm' });
    expect(physicalLengthOfUnit('kilometer')).toEqual({ size: 1, unit: 'km' });
  });

  it('accepts symbols, reading u as µ', () => {
    expect(physicalLengthOfUnit('µm')).toEqual({ size: 1, unit: 'µm' });
    expect(physicalLengthOfUnit('um')).toEqual({ size: 1, unit: 'µm' });
    expect(physicalLengthOfUnit('nm')).toEqual({ size: 1, unit: 'nm' });
  });

  it('gives non-SI lengths in metres', () => {
    expect(physicalLengthOfUnit('angstrom')).toEqual({ size: 1e-10, unit: 'm' });
    expect(physicalLengthOfUnit('inch')).toEqual({ size: 0.0254, unit: 'm' });
  });

  it('has no length for the placeholder, non-lengths or nothing', () => {
    for (const unit of ['unit', 'second', 'pixel', 'constructormeter', 'toString', '', 3, null]) {
      expect(physicalLengthOfUnit(unit)).toBeUndefined();
    }
  });
});

const axes = (unit?: string) => [
  { name: 'x', type: 'space', ...(unit && { unit }) },
  { name: 'y', type: 'space', ...(unit && { unit }) },
];

const shapes = (...outputs: { name: string; unit?: string }[]) => ({
  [ATTRS_KEY]: {
    'encoding-type': 'ngff:shapes',
    axes: ['x', 'y'],
    coordinateTransformations: outputs.map(({ name, unit }) => ({
      type: 'identity',
      input: { name: 'xy', axes: axes(unit) },
      output: { name, axes: axes(unit) },
    })),
  },
});

function storeWithShapes(tree: Record<string, unknown>) {
  const rootStore = {
    tree: { shapes: tree },
    zarritaStore: { get: async () => undefined, contents: () => [] },
  } as unknown as ConsolidatedStore;
  return new SpatialData('https://example.com/mock.zarr', rootStore, ['shapes']);
}

describe('no-length-unit issue', () => {
  it('is reported per coordinate system an element maps into without a length unit', () => {
    const sdata = storeWithShapes({
      cells: shapes({ name: 'global', unit: 'unit' }, { name: 'aligned' }),
      nuclei: shapes({ name: 'global', unit: 'micrometer' }),
    });
    expect(sdata.getIssues()).toEqual([
      {
        path: 'shapes/cells',
        issue: {
          kind: 'no-length-unit',
          coordinateSystem: 'global',
          remedy: { op: 'declare-length-unit', coordinateSystem: 'global' },
        },
      },
      { path: 'shapes/cells', issue: expect.objectContaining({ coordinateSystem: 'aligned' }) },
    ]);
  });

  it('is described in words', () => {
    const [{ issue }] = storeWithShapes({ cells: shapes({ name: 'global' }) }).getIssues();
    expect(describeElementIssue(issue)).toContain("'global'");
  });
});
