import type { PointsTilingMetadata } from '@spatialdata/core';
import { describe, expect, it } from 'vitest';

import {
  planPointsLoads,
  pointsPreloadCacheKey,
  shouldLoadPointsRowFeatureCodes,
  shouldPreloadAfterMetadataProbe,
} from '../src/pointsLoadPlan.js';

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
    // planPointsLoads only checks tiledMetadata for presence; a minimal partial
    // stands in for a full PointsTilingMetadata here.
    const tiledMetadata = {
      supportsRowGroupRangeReads: true,
      bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
    } as unknown as PointsTilingMetadata;
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

describe('pointsPreloadCacheKey', () => {
  it('includes memory cap only (feature filter is runtime)', () => {
    expect(
      pointsPreloadCacheKey('points:transcripts', {
        pointsMemoryCap: 1_000_000,
      })
    ).toBe('points:transcripts|m1000000');
  });

  it('uses default memory cap when unset', () => {
    expect(pointsPreloadCacheKey('points:transcripts', {})).toMatch(/m\d+$/);
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

describe('shouldLoadPointsRowFeatureCodes', () => {
  it('does not load row codes before preloaded points exist', () => {
    expect(
      shouldLoadPointsRowFeatureCodes({
        hasPreloaded: false,
        hasCached: false,
        inFlight: false,
        featureCodes: [1],
      })
    ).toBe(false);
  });

  it('loads row codes once preload is ready, regardless of filter state', () => {
    expect(
      shouldLoadPointsRowFeatureCodes({
        hasPreloaded: true,
        hasCached: false,
        inFlight: false,
        featureCodes: undefined,
      })
    ).toBe(true);
    expect(
      shouldLoadPointsRowFeatureCodes({
        hasPreloaded: true,
        hasCached: false,
        inFlight: false,
        featureCodes: [],
      })
    ).toBe(true);
    expect(
      shouldLoadPointsRowFeatureCodes({
        hasPreloaded: true,
        hasCached: false,
        inFlight: false,
        featureCodes: [1, 2],
      })
    ).toBe(true);
  });

  it('skips row codes when cached or already in flight', () => {
    expect(
      shouldLoadPointsRowFeatureCodes({
        hasPreloaded: true,
        hasCached: true,
        inFlight: false,
        featureCodes: [1, 2],
      })
    ).toBe(false);
    expect(
      shouldLoadPointsRowFeatureCodes({
        hasPreloaded: true,
        hasCached: false,
        inFlight: true,
        featureCodes: [1, 2],
      })
    ).toBe(false);
  });
});
