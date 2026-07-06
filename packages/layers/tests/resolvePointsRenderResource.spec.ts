import { describe, expect, it } from 'vitest';

import { pointsRenderResourceSignature } from '../src/resolvePointsRenderResource.js';

describe('pointsRenderResourceSignature', () => {
  it('changes when preload or metadata inputs change', () => {
    const element = { key: 'transcripts' } as { key: string };
    const base = pointsRenderResourceSignature(
      element as never,
      { metadataKnown: true, tilingMetadata: null, preloaded: null },
      { experimentalOptimizations: 'auto' }
    );
    const withPreload = pointsRenderResourceSignature(
      element as never,
      {
        metadataKnown: true,
        tilingMetadata: null,
        preloaded: { shape: [2, 100], data: [new Float32Array(100), new Float32Array(100)] },
      },
      { experimentalOptimizations: 'auto', preloadCacheKey: 'points:transcripts|m4000000|fall' }
    );
    const withMoreRows = pointsRenderResourceSignature(
      element as never,
      {
        metadataKnown: true,
        tilingMetadata: null,
        preloaded: { shape: [2, 200], data: [new Float32Array(200), new Float32Array(200)] },
      },
      { experimentalOptimizations: 'auto', preloadCacheKey: 'points:transcripts|m4000000|fall' }
    );
    expect(base).not.toEqual(withPreload);
    expect(withPreload).not.toEqual(withMoreRows);
  });
});
