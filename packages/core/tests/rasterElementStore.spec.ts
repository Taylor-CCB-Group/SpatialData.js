import { describe, expect, it, vi } from 'vitest';
import { ATTRS_KEY } from 'zarrextra';
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

function createImageElement(zarritaStore: { get: (key: string) => Promise<null> } = fakeStore()) {
  return new ImageElement({
    sdata: {
      rootStore: { tree: createTree(), zarritaStore },
      // biome-ignore lint/suspicious/noExplicitAny: minimal SDataProps test double
    } as any,
    name: 'images',
    key: 'morphology',
  });
}

function fakeStore() {
  return { get: vi.fn(async () => null) };
}

describe('RasterElement.getStore', () => {
  it('hands out one stable store view per element', () => {
    const element = createImageElement();

    expect(element.getStore()).toBe(element.getStore());
  });

  it('gives different elements different views', () => {
    expect(createImageElement().getStore()).not.toBe(createImageElement().getStore());
  });

  it('still resolves keys under the element path', async () => {
    const store = fakeStore();
    const element = createImageElement(store);

    // biome-ignore lint/suspicious/noExplicitAny: zarrita brands absolute paths
    await element.getStore().get('/0/c/0/0' as any);

    expect(store.get).toHaveBeenCalledWith('/images/morphology/0/c/0/0', undefined);
  });
});
