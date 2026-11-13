import { describe, expect, it } from 'vitest';
import {
  buildDemoPageHref,
  DEFAULT_DEMO_SPATIALDATA_URL,
  getCatalogUrlFromSearchParams,
  getSpatialDataUrlFromSearchParams,
  parseCatalog,
} from '../src/Sketch/demoUrl.js';

describe('getSpatialDataUrlFromSearchParams', () => {
  it('uses fallback when url param is absent', () => {
    expect(getSpatialDataUrlFromSearchParams(new URLSearchParams())).toBe(
      DEFAULT_DEMO_SPATIALDATA_URL
    );
  });

  it('reads url param', () => {
    const store = 'https://example.com/data.zarr';
    expect(getSpatialDataUrlFromSearchParams(new URLSearchParams({ url: store }))).toBe(store);
  });

  it('decodes encoded url param', () => {
    const store = 'https://example.com/a b.zarr';
    expect(
      getSpatialDataUrlFromSearchParams(new URLSearchParams({ url: encodeURIComponent(store) }))
    ).toBe(store);
  });

  it('treats blank url param as fallback', () => {
    expect(getSpatialDataUrlFromSearchParams(new URLSearchParams({ url: '  ' }))).toBe(
      DEFAULT_DEMO_SPATIALDATA_URL
    );
  });
});

describe('buildDemoPageHref', () => {
  it('sets url search param', () => {
    const href = buildDemoPageHref('https://example.com/dataset.zarr', 'https://demo.test/sketch');
    expect(href).toBe('https://demo.test/sketch?url=https%3A%2F%2Fexample.com%2Fdataset.zarr');
  });
});

describe('catalog', () => {
  const page = 'http://127.0.0.1:8000/?catalog=%2Ftok%2Fcatalog.json';

  it('resolves ?catalog= against the page', () => {
    const params = new URL(page).searchParams;
    expect(getCatalogUrlFromSearchParams(params, page)).toBe(
      'http://127.0.0.1:8000/tok/catalog.json'
    );
    expect(getCatalogUrlFromSearchParams(new URLSearchParams(), page)).toBeNull();
  });

  it('resolves store urls against the catalog and drops malformed entries', () => {
    const catalog = 'http://127.0.0.1:8000/tok/catalog.json';
    const json = {
      stores: [{ path: 'run 1/a.zarr', url: 'data/run%201/a.zarr' }, { path: 3 }, 'x'],
    };
    expect(parseCatalog(json, catalog)).toEqual([
      { path: 'run 1/a.zarr', url: 'http://127.0.0.1:8000/tok/data/run%201/a.zarr' },
    ]);
    expect(() => parseCatalog({ nope: true }, catalog)).toThrow();
  });
});
