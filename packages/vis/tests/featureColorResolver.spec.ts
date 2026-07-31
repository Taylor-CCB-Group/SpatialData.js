import type { FeatureColorBuffer } from '@spatialdata/layers';
import { describe, expect, it } from 'vitest';
import { createFeatureColorStabilizer } from '../src/SpatialCanvas/featureColorResolver';

/**
 * The stabilizer is the guard rail on the resolver's stability contract.
 *
 * Hosts are asked to return the same object when nothing changed, but the thing
 * that actually costs is the `colors` buffer — and returning a fresh `{colors,
 * count}` wrapper around a reused buffer is an easy mistake that would re-upload a
 * multi-megabyte texture every frame while looking completely correct.
 */

describe('createFeatureColorStabilizer', () => {
  const buffer = (colors: Uint8Array, count: number): FeatureColorBuffer => ({ colors, count });

  it('collapses a fresh wrapper around unchanged bytes onto the first wrapper', () => {
    const stabilize = createFeatureColorStabilizer();
    const colors = new Uint8Array([1, 2, 3, 4]);

    const first = stabilize('layer-1', buffer(colors, 1));
    const second = stabilize('layer-1', buffer(colors, 1));

    expect(second).toBe(first);
  });

  it('passes a genuinely new buffer through', () => {
    const stabilize = createFeatureColorStabilizer();
    const first = stabilize('layer-1', buffer(new Uint8Array([1, 2, 3, 4]), 1));
    const second = stabilize('layer-1', buffer(new Uint8Array([9, 9, 9, 9]), 1));

    expect(second).not.toBe(first);
    expect(second?.colors[0]).toBe(9);
  });

  it('treats a changed count as a change even when the bytes are reused', () => {
    // A host that grows its element in place keeps the same allocation; the count
    // is what tells us the covered range moved.
    const stabilize = createFeatureColorStabilizer();
    const colors = new Uint8Array(8);
    const first = stabilize('layer-1', buffer(colors, 1));
    const second = stabilize('layer-1', buffer(colors, 2));

    expect(second).not.toBe(first);
    expect(second?.count).toBe(2);
  });

  it('keeps layers independent', () => {
    const stabilize = createFeatureColorStabilizer();
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([5, 6, 7, 8]);

    const firstA = stabilize('layer-a', buffer(a, 1));
    stabilize('layer-b', buffer(b, 1));

    expect(stabilize('layer-a', buffer(a, 1))).toBe(firstA);
  });

  it('drops the entry when a layer stops resolving, so it cannot go stale', () => {
    const stabilize = createFeatureColorStabilizer();
    const colors = new Uint8Array([1, 2, 3, 4]);
    const first = stabilize('layer-1', buffer(colors, 1));

    expect(stabilize('layer-1', undefined)).toBeUndefined();
    // Same bytes again — but the previous wrapper was released, so this is new.
    expect(stabilize('layer-1', buffer(colors, 1))).not.toBe(first);
  });
});
