import { describe, expect, it } from 'vitest';
import { FolderStore, getNodeAttrs, openExtraConsolidated, type PickedFile } from '../src/index';
import { readValues, VALUES, v2Files, v3Files } from './zarrFixtures';

/** Files as `<input webkitdirectory>` reports them, relative to the picked folder's parent. */
function picked(folder: string, files: Record<string, Uint8Array>): PickedFile[] {
  return Object.entries(files).map(([path, bytes]) =>
    Object.assign(new Blob([bytes]), {
      name: path.split('/').at(-1) ?? path,
      webkitRelativePath: `${folder}/${path}`,
    })
  );
}

async function openTree(store: FolderStore) {
  const result = await openExtraConsolidated(store);
  if (!result.ok) throw result.error;
  return result.value;
}

describe('FolderStore', () => {
  it('opens a picked .zarr folder without consolidated metadata by listing its files', async () => {
    const { tree, zarritaStore } = await openTree(
      FolderStore.fromFiles(picked('store.zarr', v2Files()))
    );

    expect(getNodeAttrs(tree)).toEqual({ title: 'per-node' });
    expect(await readValues(zarritaStore)).toEqual(VALUES);
  });

  it('opens a v3 folder', async () => {
    const { tree, zarritaStore } = await openTree(
      FolderStore.fromFiles(picked('store.zarr', await v3Files()))
    );

    expect(getNodeAttrs(tree)).toEqual({ title: 'v3' });
    expect(await readValues(zarritaStore)).toEqual(VALUES);
  });

  it('roots the store at a .zarr folder that is the only child of the picked folder', async () => {
    const files: Record<string, Uint8Array> = {};
    for (const [path, bytes] of Object.entries(v2Files())) {
      files[`store.zarr/${path}`] = bytes;
    }
    const { zarritaStore } = await openTree(FolderStore.fromFiles(picked('data', files)));

    expect(await readValues(zarritaStore)).toEqual(VALUES);
  });

  it('range-reads a file', async () => {
    const store = FolderStore.fromFiles(picked('store.zarr', v2Files()));
    const chunk = new Float32Array(VALUES.slice(4));

    expect(await store.getRange('/values/1', { offset: 4, length: 8 })).toEqual(
      new Uint8Array(chunk.buffer, 4, 8)
    );
    expect(await store.getRange('/values/1', { suffixLength: 4 })).toEqual(
      new Uint8Array(chunk.buffer, 12, 4)
    );
    expect(await store.get('/missing')).toBeUndefined();
  });
});
