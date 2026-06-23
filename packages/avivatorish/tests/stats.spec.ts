import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getChannelStatsMock } = vi.hoisted(() => ({
  getChannelStatsMock: vi.fn((data: number) => ({
    domain: [data, data + 1],
    contrastLimits: [data + 2, data + 3],
  })),
}));

vi.mock('@hms-dbmi/viv', async () => {
  const actual = await vi.importActual<typeof import('@hms-dbmi/viv')>('@hms-dbmi/viv');
  return {
    ...actual,
    getChannelStats: getChannelStatsMock,
  };
});

import {
  getChannelSelectionStats,
  getSingleSelectionStats2D,
  getSingleSelectionStats3D,
} from '../src/utils';

describe('getSingleSelectionStats2D', () => {
  beforeEach(() => {
    getChannelStatsMock.mockClear();
  });

  it('drops axes that are not present before 2D raster reads', async () => {
    const selection = { c: 0, z: 0, t: 0 };
    const getRaster = vi.fn(
      async ({ selection: currentSelection }: { selection: Record<string, number> }) => ({
        data: 10,
        selection: currentSelection,
      })
    );
    const loader = {
      labels: ['y', 'x'],
      shape: [64, 64],
      getRaster,
    };

    const result = await getSingleSelectionStats2D({ loader, selection });

    expect(getRaster).toHaveBeenCalledTimes(1);
    expect(getRaster).toHaveBeenCalledWith({ selection: {} });
    expect(result).toEqual({
      domain: [10, 11],
      contrastLimits: [12, 13],
    });
  });

  it('returns raster dimensions when includeRaster is true', async () => {
    const data = new Uint16Array(64 * 64);
    const getRaster = vi.fn(async () => ({
      data,
      width: 64,
      height: 64,
    }));
    const loader = {
      labels: ['y', 'x'],
      shape: [64, 64],
      getRaster,
    };

    const result = await getSingleSelectionStats2D({
      loader,
      selection: { c: 0, z: 0, t: 0 },
      includeRaster: true,
    });

    expect(result.raster).toEqual({
      width: 64,
      height: 64,
      data,
    });
  });

  it('omits raster by default', async () => {
    const getRaster = vi.fn(async () => ({
      data: 10,
      width: 8,
      height: 8,
    }));
    const loader = {
      labels: ['y', 'x'],
      shape: [8, 8],
      getRaster,
    };

    const result = await getSingleSelectionStats2D({
      loader,
      selection: { c: 0, z: 0, t: 0 },
    });

    expect(result.raster).toBeUndefined();
  });
});

describe('getChannelSelectionStats', () => {
  beforeEach(() => {
    getChannelStatsMock.mockClear();
  });

  it('returns rasters array when includeRaster is true', async () => {
    const getRaster = vi.fn(async () => ({
      data: new Uint8Array(4),
      width: 2,
      height: 2,
    }));
    const loader = {
      labels: ['c', 'y', 'x'],
      shape: [2, 2, 2],
      getRaster,
    };

    const result = await getChannelSelectionStats({
      loader,
      selections: [{ c: 0, z: 0, t: 0 }],
      use3d: false,
      includeRaster: true,
    });

    expect(result.rasters).toHaveLength(1);
    expect(result.rasters?.[0]).toMatchObject({ width: 2, height: 2 });
  });
});

describe('getSingleSelectionStats3D', () => {
  beforeEach(() => {
    getChannelStatsMock.mockClear();
  });

  it('uses uppercase Z labels when sampling 3D stats', async () => {
    const getRaster = vi.fn(async ({ selection }: { selection: { c?: number; z?: number } }) => ({
      data: selection.z ?? -1,
    }));
    const loader = {
      labels: ['c', 'Z', 'y', 'x'],
      shape: [2, 4, 64, 64],
      getRaster,
    };

    const result = await getSingleSelectionStats3D({
      loader,
      selection: { c: 0, z: 0, t: 0 },
    });

    expect(getRaster).toHaveBeenCalledTimes(3);
    expect(getRaster).toHaveBeenNthCalledWith(1, { selection: { c: 0, z: 0 } });
    expect(getRaster).toHaveBeenNthCalledWith(2, { selection: { c: 0, z: 2 } });
    expect(getRaster).toHaveBeenNthCalledWith(3, { selection: { c: 0, z: 3 } });
    expect(result).toEqual({
      domain: [0, 4],
      contrastLimits: [2, 6],
    });
  });

  it('falls back to 2D stats when the loader has no z axis', async () => {
    const selection = { c: 0, z: 0, t: 0 };
    const getRaster = vi.fn(
      async ({ selection: currentSelection }: { selection: { c?: number } }) => ({
        data: 10,
        selection: currentSelection,
      })
    );
    const loader = {
      labels: ['c', 'y', 'x'],
      shape: [2, 64, 64],
      getRaster,
    };

    const result = await getSingleSelectionStats3D({ loader, selection });

    expect(getRaster).toHaveBeenCalledTimes(1);
    expect(getRaster).toHaveBeenCalledWith({ selection: { c: 0 } });
    expect(result).toEqual({
      domain: [10, 11],
      contrastLimits: [12, 13],
    });
  });
});
