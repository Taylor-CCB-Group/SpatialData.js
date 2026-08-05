import { describe, expect, it, vi } from 'vitest';
import { ATTRS_KEY } from 'zarrextra';
import type * as zarr from 'zarrita';
import { ImageElement } from '../src/models/index.js';

/**
 * The store view a raster element hands out has to be *the same object* every
 * time, because the decoded chunk cache is keyed by store instance: fizarrita
 * assigns each store an id from a `WeakMap` and builds keys as
 * `store_N:{array path}:{chunk key}`, while `createPrefixedStore` returns a fresh
 * object literal per call. A view per caller would key the same chunk differently
 * per view — a cache that fills with duplicates and never hits. See ADR 0005
 * rung 3.
 */
function createTree() {
  return {
    images: {
      morphology: {
        [ATTRS_KEY]: {
          multiscales: [
            {
              datasets: [{ path: '0' }],
              axes: [
                { name: 'y', type: 'space' },
                { name: 'x', type: 'space' },
              ],
            },
          ],
        },
      },
    },
  };
}

/** The narrowest thing satisfying `ConsolidatedStore['zarritaStore']`. */
function fakeStore() {
  return {
    get: vi.fn(async (_key: zarr.AbsolutePath): Promise<Uint8Array | undefined> => undefined),
    contents: vi.fn((): { path: zarr.AbsolutePath; kind: 'array' | 'group' }[] => []),
  };
}

function createImageElement(zarritaStore: ReturnType<typeof fakeStore> = fakeStore()) {
  return new ImageElement({
    sdata: {
      source: 'test://sdata.zarr',
      rootStore: { tree: createTree(), zarritaStore },
    },
    name: 'images',
    key: 'morphology',
  });
}

/** A chunk key rooted at the element, in zarrita's branded absolute-path form. */
const CHUNK_KEY: zarr.AbsolutePath = '/0/c/0/0';

describe('RasterElement.getStore', () => {
  it('hands out one stable store view per element', () => {
    const element = createImageElement();

    expect(element.getStore()).toBe(element.getStore());
  });

  it('gives different elements different views', () => {
    // One backing store, so the assertion is about the per-element *view* rather
    // than about the two elements happening to hold different stores.
    const shared = fakeStore();

    expect(createImageElement(shared).getStore()).not.toBe(createImageElement(shared).getStore());
  });

  it('still resolves keys under the element path', async () => {
    const store = fakeStore();
    const element = createImageElement(store);

    await element.getStore().get(CHUNK_KEY);

    expect(store.get).toHaveBeenCalledWith('/images/morphology/0/c/0/0', undefined);
  });
});
