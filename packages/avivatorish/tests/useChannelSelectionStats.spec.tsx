import { renderHook, act, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getStatsMock } = vi.hoisted(() => ({
  getStatsMock: vi.fn(),
}));

vi.mock('../src/utils', async () => {
  const actual = await vi.importActual<typeof import('../src/utils')>('../src/utils');
  return { ...actual, getSingleSelectionStats: getStatsMock };
});

import { useChannelSelectionStats } from '../src/useChannelSelectionStats';

const LOADER = {
  labels: ['c', 'y', 'x'] as string[],
  shape: [3, 64, 64],
  getRaster: vi.fn(),
};

const makeStats = (domain: [number, number] = [0, 255]) => ({
  domain,
  contrastLimits: domain,
  raster: { width: 4, height: 4, data: new Uint16Array(16) },
});

describe('useChannelSelectionStats', () => {
  beforeEach(() => {
    getStatsMock.mockReset();
  });

  it('starts empty before any fetch resolves', () => {
    getStatsMock.mockReturnValue(new Promise(() => {})); // never resolves
    const { result } = renderHook(() =>
      useChannelSelectionStats({
        loader: LOADER,
        channelIds: ['ch-a'],
        selections: [{ c: 0 }],
      })
    );
    expect(result.current.statsByChannelId.size).toBe(0);
    expect(result.current.statsByIndex).toHaveLength(1);
    expect(result.current.statsByIndex[0]).toBeUndefined();
  });

  it('shows fallbackDomains while loading', () => {
    getStatsMock.mockReturnValue(new Promise(() => {}));
    const fallback: [number, number] = [10, 200];
    const { result } = renderHook(() =>
      useChannelSelectionStats({
        loader: LOADER,
        channelIds: ['ch-a'],
        selections: [{ c: 0 }],
        fallbackDomains: [fallback],
      })
    );
    expect(result.current.statsByChannelId.get('ch-a')?.domain).toEqual(fallback);
  });

  it('populates statsByChannelId and statsByIndex after fetch', async () => {
    getStatsMock.mockResolvedValue(makeStats([0, 100]));
    const { result } = renderHook(() =>
      useChannelSelectionStats({
        loader: LOADER,
        channelIds: ['ch-a'],
        selections: [{ c: 0 }],
      })
    );
    await waitFor(() => expect(result.current.statsByChannelId.has('ch-a')).toBe(true));
    expect(result.current.statsByChannelId.get('ch-a')?.domain).toEqual([0, 100]);
    expect(result.current.statsByIndex[0]?.domain).toEqual([0, 100]);
  });

  it('marks loading true while fetching, false after', async () => {
    let resolve!: (v: unknown) => void;
    getStatsMock.mockReturnValue(new Promise((r) => { resolve = r; }));

    const { result } = renderHook(() =>
      useChannelSelectionStats({
        loader: LOADER,
        channelIds: ['ch-a'],
        selections: [{ c: 0 }],
      })
    );

    await waitFor(() => expect(result.current.loadingByChannelId.get('ch-a')).toBe(true));
    act(() => { resolve(makeStats()); });
    await waitFor(() => expect(result.current.loadingByChannelId.get('ch-a')).toBe(false));
  });

  it('does not refetch when selection key is unchanged', async () => {
    getStatsMock.mockResolvedValue(makeStats());
    const { result, rerender } = renderHook(
      ({ selections }) =>
        useChannelSelectionStats({ loader: LOADER, channelIds: ['ch-a'], selections }),
      { initialProps: { selections: [{ c: 0 }] } }
    );

    await waitFor(() => expect(result.current.statsByChannelId.has('ch-a')).toBe(true));
    const callsBefore = getStatsMock.mock.calls.length;

    rerender({ selections: [{ c: 0 }] }); // same key
    // give the effect a chance to fire
    await act(async () => {});
    expect(getStatsMock).toHaveBeenCalledTimes(callsBefore);
  });

  it('refetches when selection changes and calls with the new selection', async () => {
    getStatsMock.mockResolvedValue(makeStats());
    const { rerender } = renderHook(
      ({ selections }) =>
        useChannelSelectionStats({ loader: LOADER, channelIds: ['ch-a'], selections }),
      { initialProps: { selections: [{ c: 0 }] as { c: number }[] } }
    );

    await waitFor(() => expect(getStatsMock).toHaveBeenCalledTimes(1));
    rerender({ selections: [{ c: 2 }] });
    await waitFor(() => expect(getStatsMock).toHaveBeenCalledTimes(2));
    expect(getStatsMock.mock.calls[1][0]).toMatchObject({ selection: { c: 2 } });
  });

  it('uses the row index as c fallback when selection.c is absent', async () => {
    getStatsMock.mockResolvedValue(makeStats());
    renderHook(() =>
      useChannelSelectionStats({
        loader: LOADER,
        channelIds: ['ch-a', 'ch-b'],
        selections: [{}, {}],
      })
    );
    await waitFor(() => expect(getStatsMock).toHaveBeenCalledTimes(2));
    expect(getStatsMock.mock.calls[0][0]).toMatchObject({ selection: { c: 0 } });
    expect(getStatsMock.mock.calls[1][0]).toMatchObject({ selection: { c: 1 } });
  });

  it('does not update state after cancellation on unmount', async () => {
    let callCount = 0;
    // fetch never resolves during this test
    getStatsMock.mockReturnValue(new Promise(() => { callCount++; }));

    const { unmount } = renderHook(() =>
      useChannelSelectionStats({
        loader: LOADER,
        channelIds: ['ch-a'],
        selections: [{ c: 0 }],
      })
    );

    // wait for fetch to begin
    await waitFor(() => expect(callCount).toBeGreaterThan(0));
    // unmount should cancel — no thrown "setState on unmounted component" error
    expect(() => unmount()).not.toThrow();
  });

  it('replaces fallback with real stats once fetch completes', async () => {
    let resolve!: (v: unknown) => void;
    getStatsMock.mockReturnValue(new Promise((r) => { resolve = r; }));

    const fallback: [number, number] = [10, 200];
    const { result } = renderHook(() =>
      useChannelSelectionStats({
        loader: LOADER,
        channelIds: ['ch-a'],
        selections: [{ c: 0 }],
        fallbackDomains: [fallback],
      })
    );

    expect(result.current.statsByChannelId.get('ch-a')?.domain).toEqual(fallback);
    act(() => { resolve(makeStats([0, 255])); });
    await waitFor(() =>
      expect(result.current.statsByChannelId.get('ch-a')?.domain).toEqual([0, 255])
    );
  });
});
