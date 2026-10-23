import { describe, expect, it } from 'vitest';
import {
  buildDemoPageHref,
  DEFAULT_DEMO_SPATIALDATA_URL,
  getSpatialDataUrlFromSearchParams,
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
