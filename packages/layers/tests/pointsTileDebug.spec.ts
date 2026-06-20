import { describe, expect, it } from 'vitest';

import {
  formatPointsTileDebugTooltip,
  reduceTileDebugEntries,
} from '../src/pointsTileDebug.js';

const sampleTile = {
  tileId: '1-2--1',
  index: { x: 1, y: 2, z: -1 },
  bbox: { left: 512, top: 1024, right: 1024, bottom: 512 },
};

describe('pointsTileDebug', () => {
  it('transitions tile status through viewport, start, and end events', () => {
    const at = 1_000;
    let entries = reduceTileDebugEntries([], {
      type: 'viewport',
      tiles: [sampleTile],
      at,
    });
    expect(entries[0]?.status).toBe('pending');

    entries = reduceTileDebugEntries(entries, { type: 'start', tile: sampleTile, at: at + 10 });
    expect(entries[0]?.status).toBe('loading');
    expect(entries[0]?.startedAt).toBe(at + 10);

    entries = reduceTileDebugEntries(entries, {
      type: 'end',
      tile: sampleTile,
      at: at + 100,
      clipBounds: { minX: 512, minY: 512, maxX: 1024, maxY: 1024 },
      result: { success: true, pointCount: 42, loadMode: 'row-groups' },
    });
    expect(entries[0]?.status).toBe('loaded');
    expect(entries[0]?.pointCount).toBe(42);
    expect(entries[0]?.completedAt).toBe(at + 100);
  });

  it('formats tooltip with elapsed time for in-flight tiles', () => {
    const tooltip = formatPointsTileDebugTooltip(
      {
        tileId: sampleTile.tileId,
        index: sampleTile.index,
        bbox: { minX: 512, minY: 512, maxX: 1024, maxY: 1024 },
        clippedBounds: null,
        status: 'loading',
        requestedAt: 1_000,
        startedAt: 1_500,
      },
      { inFlight: 1, loaded: 0, viewportTotal: 3 },
      2_000
    );
    expect(tooltip.items.some((item) => item.label === 'elapsed' && item.value === '500ms')).toBe(
      true
    );
  });
});
