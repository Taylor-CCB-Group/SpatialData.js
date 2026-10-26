import { Matrix4 } from '@math.gl/core';
import { CoordinateSystemNotFoundError, type SpatialData } from '@spatialdata/core';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { EntryStatus } from '../src/SpatialCanvas/entryStatus.js';
import { useSpatialCanvasRendererFromLayerInputs } from '../src/SpatialCanvas/SpatialCanvasViewer.js';
import type { LayerConfig } from '../src/SpatialCanvas/types.js';
import { VivLoaderRegistryProvider } from '../src/SpatialCanvas/VivLoaderRegistry.js';

/**
 * What a host embedding the canvas can learn about a layer that drew nothing:
 * the typed error, through `getEntryStatus` and `onEntryStatusChange`, and a way
 * back through `retryEntry`.
 */

const vivLoader = () => [{ labels: ['y', 'x'], shape: [64, 64], dtype: 'uint16' }];

function imageElement(key: string, transform: 'global' | 'none' = 'global') {
  return {
    key,
    path: `images/${key}`,
    attrs: {},
    // Tagged so a test's fetch can tell the elements apart.
    getStore: () => ({ key }),
    getTransformation: (cs: string) =>
      transform === 'global' && cs === 'global'
        ? { ok: true, value: { toMatrix: () => new Matrix4() } }
        : { ok: false, error: new CoordinateSystemNotFoundError(cs, key, ['aligned']) },
  };
}

type MultiscalesSource = { store: { key: string } };

const imageLayer = (id: string, elementKey: string): LayerConfig => ({
  id,
  type: 'image',
  elementKey,
  visible: true,
  opacity: 1,
});

function renderCanvas(options: {
  fetch: (source: MultiscalesSource) => Promise<unknown>;
  transform?: 'global' | 'none';
  layers: Record<string, LayerConfig>;
}) {
  const registry = { getOmeZarrMultiscalesData: options.fetch };
  const wrapper = ({ children }: PropsWithChildren) => (
    <VivLoaderRegistryProvider value={registry}>{children}</VivLoaderRegistryProvider>
  );
  // A stub: the renderer reads only `images` and each element's transform here.
  const spatialData = {
    images: {
      img: imageElement('img', options.transform),
      img2: imageElement('img2', options.transform),
    },
  } as unknown as SpatialData;
  const onEntryStatusChange = vi.fn<(layerId: string, status: EntryStatus | undefined) => void>();
  const hook = renderHook(
    ({ layers }: { layers: Record<string, LayerConfig> }) =>
      useSpatialCanvasRendererFromLayerInputs({
        spatialData,
        coordinateSystem: 'global',
        layerInputs: { layers, layerOrder: Object.keys(layers) },
        width: 100,
        height: 100,
        autoFit: false,
        onEntryStatusChange,
      }),
    { wrapper, reactStrictMode: true, initialProps: { layers: options.layers } }
  );
  return { ...hook, onEntryStatusChange };
}

describe('entry status — an entry that cannot be resolved', () => {
  it('reports a missing element as element-not-found, once', () => {
    const { result, onEntryStatusChange } = renderCanvas({
      fetch: async () => vivLoader(),
      layers: { missing: imageLayer('missing', 'no_such_image') },
    });

    const error = result.current.getEntryStatus('missing')?.errors[0];
    expect(error?.resource).toBe('element');
    expect(error?.error.kind).toBe('element-not-found');
    expect(error?.error.retryable).toBe(false);
    expect(onEntryStatusChange).toHaveBeenCalledTimes(1);
    expect(onEntryStatusChange).toHaveBeenCalledWith(
      'missing',
      result.current.getEntryStatus('missing')
    );
  });

  it('reports an element with no transform to the coordinate system, with the ones it has', () => {
    const { result } = renderCanvas({
      fetch: async () => vivLoader(),
      transform: 'none',
      layers: { l: imageLayer('l', 'img') },
    });

    const error = result.current.getEntryStatus('l')?.errors[0]?.error;
    if (error?.kind !== 'coordinate-system-not-found') throw new Error(`got ${error?.kind}`);
    expect(error.coordinateSystem).toBe('global');
    expect(error.availableCoordinateSystems).toEqual(['aligned']);
  });

  it('clears the status through the callback when the layer is removed', () => {
    const { rerender, onEntryStatusChange } = renderCanvas({
      fetch: async () => vivLoader(),
      layers: { missing: imageLayer('missing', 'no_such_image') },
    });

    rerender({ layers: {} });

    expect(onEntryStatusChange).toHaveBeenLastCalledWith('missing', undefined);
  });
});

describe('entry status — a load that fails', () => {
  it('reports the typed error, and retryEntry loads it again', async () => {
    let call = 0;
    const fetch = vi.fn(async () => {
      call += 1;
      // StrictMode mounts twice, so the first two loads are the initial one.
      if (call <= 2) throw new Error('the store is unreachable');
      return vivLoader();
    });
    const { result, onEntryStatusChange } = renderCanvas({
      fetch,
      layers: { l: imageLayer('l', 'img') },
    });

    await waitFor(() => expect(result.current.getEntryStatus('l')?.errors).toHaveLength(1));
    const [failure] = result.current.getEntryStatus('l')?.errors ?? [];
    expect(failure?.resource).toBe('loader');
    expect(failure?.error.kind).toBe('load-failed');
    expect(failure?.error.retryable).toBe(true);
    const callsAfterFailure = fetch.mock.calls.length;

    await act(() => result.current.retryEntry('l'));

    await waitFor(() => expect(result.current.getEntryStatus('l')).toBeUndefined());
    expect(fetch.mock.calls.length).toBe(callsAfterFailure + 1);
    expect(onEntryStatusChange).toHaveBeenLastCalledWith('l', undefined);
  });

  it("keeps a failure's identity while another layer of the same kind loads", async () => {
    const pending: Array<(loader: unknown) => void> = [];
    const fetch = vi.fn((source: MultiscalesSource) =>
      source.store.key === 'img'
        ? Promise.reject(new Error('the store is unreachable'))
        : new Promise<unknown>((resolve) => pending.push(resolve))
    );
    const { result, onEntryStatusChange } = renderCanvas({
      fetch,
      layers: { l: imageLayer('l', 'img'), other: imageLayer('other', 'img2') },
    });
    await waitFor(() => expect(result.current.getEntryStatus('l')).toBeDefined());
    await waitFor(() => expect(pending.length).toBeGreaterThan(0));
    const status = result.current.getEntryStatus('l');
    const reportsForL = () => onEntryStatusChange.mock.calls.filter(([id]) => id === 'l').length;
    const before = reportsForL();

    // Settling `img2` bumps the images resolver, which re-creates every images snapshot.
    await act(async () => {
      for (const resolve of pending) resolve(vivLoader());
    });
    await waitFor(() =>
      expect(result.current.getImageLoadedDataByElementKey('img2')).toBeDefined()
    );

    expect(result.current.getEntryStatus('l')).toBe(status);
    expect(reportsForL()).toBe(before);
  });
});
