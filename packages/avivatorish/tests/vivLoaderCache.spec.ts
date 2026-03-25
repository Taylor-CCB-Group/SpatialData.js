import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  __resetVivLoaderCachesForTests,
  getOrCreateVivLoader,
  getVivLoaderCacheTelemetry,
} from '../src/vivLoaderCache';
import * as utils from '../src/utils';

beforeEach(() => {
  __resetVivLoaderCachesForTests();
  vi.restoreAllMocks();
});

describe('getOrCreateVivLoader', () => {
  it('coalesces in-flight string URL loads (single createLoader)', async () => {
    let resolveLoader!: (v: unknown) => void;
    const promise = new Promise<unknown>((r) => {
      resolveLoader = r;
    });
    const createSpy = vi.spyOn(utils, 'createLoader').mockReturnValue(promise as never);

    const p1 = getOrCreateVivLoader('https://example.com/test.zarr', () => {}, () => {});
    const p2 = getOrCreateVivLoader('https://example.com/test.zarr', () => {}, () => {});

    expect(createSpy).toHaveBeenCalledTimes(1);

    const wrapped = { data: [{ labels: ['y', 'x'], shape: [10, 10] }] };
    resolveLoader(wrapped);

    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toBe(b);

    const tel = getVivLoaderCacheTelemetry();
    expect(tel.loaderCacheMissNew).toBeGreaterThanOrEqual(1);
  });

  it('returns cached value on second call for same string URL', async () => {
    const wrapped = { data: [{ labels: ['y', 'x'], shape: [4, 4] }] };
    vi.spyOn(utils, 'createLoader').mockResolvedValue(wrapped as never);

    const a = await getOrCreateVivLoader('https://example.com/cached.zarr', () => {}, () => {});
    const b = await getOrCreateVivLoader('https://example.com/cached.zarr', () => {}, () => {});
    expect(a).toBe(b);
    expect(utils.createLoader).toHaveBeenCalledTimes(1);
  });
});
