import { describe, expect, it } from 'vitest';
import { ATTRS_KEY, type ConsolidatedStore, ZARRAY_KEY } from 'zarrextra';
import { elementIssuesNotice } from '../src/issues.js';
import {
  assessRasterLevels,
  describeRasterLayoutIssue,
  parseArrayMetadata,
  type RasterLevelInfo,
} from '../src/rasterLayout.js';
import { SpatialData } from '../src/store/index.js';

const level = (side: number, chunk: number, bytes = 2): RasterLevelInfo => ({
  path: String(side),
  shape: [1, side, side],
  chunks: [1, chunk, chunk],
  bytesPerElement: bytes,
});

describe('assessRasterLevels', () => {
  it('accepts a pyramid that reaches a small level with modest chunks', () => {
    expect(assessRasterLevels([level(8192, 512), level(4096, 512), level(2048, 512)])).toEqual([]);
  });

  it('reports a single large level as no-pyramid', () => {
    expect(assessRasterLevels([level(8192, 512)])).toMatchObject([
      { kind: 'no-pyramid', width: 8192, height: 8192, remedy: { op: 'build-pyramid' } },
    ]);
  });

  it('reports a pyramid that stops early', () => {
    expect(assessRasterLevels([level(8192, 512), level(4096, 512)])).toMatchObject([
      { kind: 'coarsest-level-large', levels: 2, width: 4096, height: 4096 },
    ]);
  });

  it('reports oversized finest-level chunks', () => {
    const issues = assessRasterLevels([level(4096, 4096), level(2048, 512)]);
    expect(issues).toMatchObject([
      {
        kind: 'oversized-chunks',
        chunkWidth: 4096,
        chunkHeight: 4096,
        decodedBytes: 4096 * 4096 * 2,
      },
    ]);
  });

  it('honours custom budgets', () => {
    const levels = [level(1024, 512)];
    expect(assessRasterLevels(levels)).toEqual([]);
    expect(
      assessRasterLevels(levels, { coarsestLevelPixels: 1, chunkDecodedBytes: 1 })
    ).toHaveLength(2);
  });
});

describe('parseArrayMetadata', () => {
  it('reads v2 .zarray', () => {
    expect(
      parseArrayMetadata('0', { shape: [1, 10, 20], chunks: [1, 5, 5], dtype: '<u2' })
    ).toEqual({
      path: '0',
      shape: [1, 10, 20],
      chunks: [1, 5, 5],
      bytesPerElement: 2,
    });
  });

  it("uses a sharding codec's inner chunk, not the shard", () => {
    const meta = {
      shape: [1, 4096, 4096],
      data_type: 'uint8',
      chunk_grid: { configuration: { chunk_shape: [1, 2048, 2048] } },
      codecs: [{ name: 'sharding_indexed', configuration: { chunk_shape: [1, 256, 256] } }],
    };
    expect(parseArrayMetadata('0', meta)?.chunks).toEqual([1, 256, 256]);
  });

  it('returns null for metadata it does not understand', () => {
    expect(parseArrayMetadata('0', { shape: [1] })).toBeNull();
    expect(parseArrayMetadata('0', null)).toBeNull();
  });
});

describe('elementIssuesNotice', () => {
  it('is undefined without issues and carries them otherwise', () => {
    expect(elementIssuesNotice([], describeRasterLayoutIssue)).toBeUndefined();
    const issues = assessRasterLevels([level(8192, 512)]);
    expect(elementIssuesNotice(issues, describeRasterLayoutIssue)).toMatchObject({
      kind: 'element-issues',
      issues,
    });
  });
});

describe('SpatialData.getIssues', () => {
  const array = (side: number, chunk: number) => ({
    [ZARRAY_KEY]: { shape: [1, side, side], chunks: [1, chunk, chunk], dtype: '|u1' },
    get: async () => undefined,
  });
  const image = (levels: Record<string, unknown>) => ({
    [ATTRS_KEY]: {
      multiscales: [
        {
          axes: [
            { name: 'c', type: 'channel' },
            { name: 'y', type: 'space' },
            { name: 'x', type: 'space' },
          ],
          datasets: Object.keys(levels).map((path) => ({ path })),
        },
      ],
    },
    ...levels,
  });

  it('lists issues from every element, keyed by path', async () => {
    const rootStore = {
      tree: {
        images: {
          flat: image({ '0': array(8192, 512) }),
          fine: image({ '0': array(4096, 512), '1': array(2048, 512) }),
          flat2: image({ '0': array(8192, 512) }),
        },
      },
      zarritaStore: { get: async () => undefined, contents: () => [] },
    } as unknown as ConsolidatedStore;
    const sdata = new SpatialData('https://example.com/mock.zarr', rootStore, ['images']);
    const expected = [
      { path: 'images/flat', issue: expect.objectContaining({ kind: 'no-pyramid' }) },
      { path: 'images/flat2', issue: expect.objectContaining({ kind: 'no-pyramid' }) },
    ];
    expect(sdata.getIssues()).toEqual(expected);
    expect(await sdata.assessIssues()).toEqual(expected);
  });
});
