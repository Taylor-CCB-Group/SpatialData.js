import { Matrix4 } from '@math.gl/core';
import type { SpatialData } from '@spatialdata/core';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { describe, expect, it } from 'vitest';
import { useSpatialCanvasRendererFromLayerInputs } from '../src/SpatialCanvas/SpatialCanvasViewer.js';
import type { LayerConfig } from '../src/SpatialCanvas/types.js';
import { VivLoaderRegistryProvider } from '../src/SpatialCanvas/VivLoaderRegistry.js';

/**
 * The image path through the renderer hook under StrictMode.
 *
 * The dev double-mount disposes the entry store mid-load and starts a second load
 * for the same image. Whichever of the two settles first, the image must end up
 * in `vivLayerProps` once its live loader is ready — the data being loaded is not
 * enough if nothing re-derives the Viv props from it.
 */

function controllableFetch() {
  const pending: Array<(loader: unknown) => void> = [];
  const fetch = () => new Promise<unknown>((resolve) => pending.push(resolve));
  return { fetch, pending };
}

function renderImageLayer(fetch: () => Promise<unknown>) {
  const registry = { getOmeZarrMultiscalesData: fetch };
  const wrapper = ({ children }: PropsWithChildren) => (
    <VivLoaderRegistryProvider value={registry}>{children}</VivLoaderRegistryProvider>
  );
  const image = {
    key: 'img',
    path: 'images/img',
    attrs: {},
    getStore: () => ({}),
    getTransformation: () => ({ ok: true, value: { toMatrix: () => new Matrix4() } }),
  };
  // A stub: the renderer reads only `images` and each element's transform here.
  const spatialData = { images: { img: image } } as unknown as SpatialData;
  const layers: Record<string, LayerConfig> = {
    'layer-img': { id: 'layer-img', type: 'image', elementKey: 'img', visible: true, opacity: 1 },
  };
  const layerOrder = ['layer-img'];

  return renderHook(
    () =>
      useSpatialCanvasRendererFromLayerInputs({
        spatialData,
        coordinateSystem: 'global',
        layerInputs: { layers, layerOrder },
        width: 100,
        height: 100,
        autoFit: false,
      }),
    { wrapper, reactStrictMode: true }
  );
}

describe('useSpatialCanvasRendererFromLayerInputs — image loads under StrictMode', () => {
  it.each([
    ['the disposed load settles first', [0, 1]],
    ['the live load settles first', [1, 0]],
  ])('draws the image when %s', async (_label, order) => {
    const { fetch, pending } = controllableFetch();
    const { result } = renderImageLayer(fetch);

    // One load per mount: StrictMode's dispose orphans the first.
    await waitFor(() => expect(pending).toHaveLength(2));
    const live = { live: true };
    const loaders = [{ disposed: true }, live];
    for (const index of order) {
      await act(async () => pending[index](loaders[index]));
    }

    expect(result.current.getImageLoadedDataByElementKey('img')?.loader).toBe(live);
    await waitFor(() => {
      expect(result.current.vivLayerProps.map((props) => props.loader)).toEqual([live]);
    });
  });
});
