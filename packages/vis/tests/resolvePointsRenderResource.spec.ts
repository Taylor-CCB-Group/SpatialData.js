import { describe, expect, it } from 'vitest';

import { pointsRenderResourceSignature } from '../src/SpatialCanvas/resolvePointsRenderResource.js';

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
        preloaded: { shape: [2], data: [[0, 1], [0, 1]] },
      },
      { experimentalOptimizations: 'auto' }
    );
    expect(base).not.toEqual(withPreload);
  });
});
