import { describe, expect, it } from 'vitest';
import type { EntryResources } from '../src/engine/index.js';
import { SnapshotCache } from '../src/engine/index.js';

/**
 * The memo behind every resolver's `snapshot()`. Its whole job is to invalidate on
 * exactly the things a snapshot embeds — entry, version, transform, config — and
 * nothing else, so it recurs across three resolvers in two packages.
 */

const entryResources = (entryId: string, elementKey: string): EntryResources => ({
  entryId,
  elementKey,
  resources: {},
  notices: [],
  bounds: null,
  revision: 0,
});

const transformA = {};
const transformB = {};

describe('SnapshotCache', () => {
  it('returns the cached value when every dimension matches', () => {
    const cache = new SnapshotCache();
    const value = entryResources('e1', 'k');
    cache.set('e1', 1, transformA, 'sig', value);

    expect(cache.get('e1', 1, transformA, 'sig')).toBe(value);
  });

  it('misses on a version bump', () => {
    const cache = new SnapshotCache();
    cache.set('e1', 1, transformA, 'sig', entryResources('e1', 'k'));

    expect(cache.get('e1', 2, transformA, 'sig')).toBeUndefined();
  });

  it('misses on a different transform identity', () => {
    const cache = new SnapshotCache();
    cache.set('e1', 1, transformA, 'sig', entryResources('e1', 'k'));

    expect(cache.get('e1', 1, transformB, 'sig')).toBeUndefined();
  });

  it('misses on a different config signature', () => {
    const cache = new SnapshotCache();
    cache.set('e1', 1, transformA, 'sig', entryResources('e1', 'k'));

    expect(cache.get('e1', 1, transformA, 'other')).toBeUndefined();
  });

  it('keeps entries sharing one element separate', () => {
    // The core reason keying by version alone is wrong: two entryIds, one element.
    const cache = new SnapshotCache();
    const a = entryResources('layer-a', 'k');
    const b = entryResources('layer-b', 'k');
    cache.set('layer-a', 1, transformA, '', a);
    cache.set('layer-b', 1, transformA, '', b);

    expect(cache.get('layer-a', 1, transformA, '')).toBe(a);
    expect(cache.get('layer-b', 1, transformA, '')).toBe(b);
  });

  it('evicts by element, dropping every entry that shared it', () => {
    const cache = new SnapshotCache();
    cache.set('layer-a', 1, transformA, '', entryResources('layer-a', 'shared'));
    cache.set('layer-b', 1, transformA, '', entryResources('layer-b', 'shared'));
    cache.set('layer-c', 1, transformA, '', entryResources('layer-c', 'other'));

    cache.evictByElement('shared');

    expect(cache.get('layer-a', 1, transformA, '')).toBeUndefined();
    expect(cache.get('layer-b', 1, transformA, '')).toBeUndefined();
    // ...but an entry over a different element is untouched.
    expect(cache.get('layer-c', 1, transformA, '')).toBeDefined();
  });

  it('clear drops everything', () => {
    const cache = new SnapshotCache();
    cache.set('e1', 1, transformA, '', entryResources('e1', 'k'));

    cache.clear();

    expect(cache.get('e1', 1, transformA, '')).toBeUndefined();
  });
});
