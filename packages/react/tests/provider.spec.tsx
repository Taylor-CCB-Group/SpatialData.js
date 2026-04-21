import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const { readZarrMock } = vi.hoisted(() => ({
  readZarrMock: vi.fn(),
}));

vi.mock('@spatialdata/core', async () => {
  const actual = await vi.importActual<typeof import('@spatialdata/core')>('@spatialdata/core');
  return {
    ...actual,
    readZarr: readZarrMock,
  };
});

import { SpatialDataProvider } from '../src/provider/SpatialDataProvider.js';

describe('SpatialDataProvider', () => {
  beforeEach(() => {
    readZarrMock.mockReset();
    readZarrMock.mockReturnValue(Promise.resolve({}));
  });

  it('accepts a store or store-like source directly', () => {
    const source = {
      get: vi.fn(),
    };

    renderToStaticMarkup(
      <SpatialDataProvider source={source as any}>
        <div>viewer</div>
      </SpatialDataProvider>
    );

    expect(readZarrMock).toHaveBeenCalledWith(source, undefined);
  });

  it('accepts a string source directly', () => {
    renderToStaticMarkup(
      <SpatialDataProvider source="https://example.com/my.zarr">
        <div>viewer</div>
      </SpatialDataProvider>
    );

    expect(readZarrMock).toHaveBeenCalledWith('https://example.com/my.zarr', undefined);
  });

  it('does not load when source is omitted', () => {
    renderToStaticMarkup(
      <SpatialDataProvider>
        <div>viewer</div>
      </SpatialDataProvider>
    );

    expect(readZarrMock).not.toHaveBeenCalled();
  });
});
