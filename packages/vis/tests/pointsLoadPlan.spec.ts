import { describe, expect, it } from 'vitest';

import {
  planPointsLoads,
  shouldPreloadAfterMetadataProbe,
} from '../src/SpatialCanvas/pointsLoadPlan.js';

describe('planPointsLoads', () => {
  it('schedules metadata probe only when optimized and metadata unknown', () => {
    expect(
      planPointsLoads({
        wantsOptimized: true,
        metadataKnown: false,
        tiledMetadata: undefined,
        hasPreloaded: false,
      })
    ).toEqual({ probeMetadata: true, preloadFullTable: false });
  });

  it('schedules preload when metadata known and non-tileable', () => {
    expect(
      planPointsLoads({
        wantsOptimized: true,
        metadataKnown: true,
        tiledMetadata: null,
        hasPreloaded: false,
      })
    ).toEqual({ probeMetadata: false, preloadFullTable: true });
  });

  it('schedules preload immediately when optimizations off', () => {
    expect(
      planPointsLoads({
        wantsOptimized: false,
        metadataKnown: false,
        tiledMetadata: undefined,
        hasPreloaded: false,
      })
    ).toEqual({ probeMetadata: false, preloadFullTable: true });
  });

  it('schedules probe only when Morton metadata is present', () => {
    const tiledMetadata = {
      supportsRowGroupRangeReads: true,
      bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
    };
    expect(
      planPointsLoads({
        wantsOptimized: true,
        metadataKnown: true,
        tiledMetadata,
        hasPreloaded: false,
      })
    ).toEqual({ probeMetadata: false, preloadFullTable: false });
  });
});

describe('shouldPreloadAfterMetadataProbe', () => {
  it('requires preload after non-tileable probe result', () => {
    expect(
      shouldPreloadAfterMetadataProbe({
        probeRan: true,
        renderableMetadata: false,
        hasPreloaded: false,
      })
    ).toBe(true);
  });

  it('skips preload when probe found renderable Morton metadata', () => {
    expect(
      shouldPreloadAfterMetadataProbe({
        probeRan: true,
        renderableMetadata: true,
        hasPreloaded: false,
      })
    ).toBe(false);
  });

  it('skips preload when data already cached', () => {
    expect(
      shouldPreloadAfterMetadataProbe({
        probeRan: true,
        renderableMetadata: false,
        hasPreloaded: true,
      })
    ).toBe(false);
  });

  it('skips preload when no probe ran', () => {
    expect(
      shouldPreloadAfterMetadataProbe({
        probeRan: false,
        renderableMetadata: false,
        hasPreloaded: false,
      })
    ).toBe(false);
  });

  it('still requires preload after probe when row count exceeds the cap', () => {
    expect(
      shouldPreloadAfterMetadataProbe({
        probeRan: true,
        renderableMetadata: false,
        hasPreloaded: false,
        totalRows: 4_000_001,
      })
    ).toBe(true);
  });
});
