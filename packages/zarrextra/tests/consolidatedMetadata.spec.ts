import { describe, expect, it } from 'vitest';
import type * as zarr from 'zarrita';
import { getNodeAttrs, openExtraConsolidated } from '../src/index';
import { json, v2Files } from './zarrFixtures';

/** A v2 store with `.zmetadata`, counting every key asked of the underlying store. */
function consolidatedV2() {
  // zarr-python consolidates a `.zattrs` for every node, empty ones included.
  const files: Record<string, Uint8Array> = { ...v2Files(), 'values/.zattrs': json({}) };
  const metadata = Object.fromEntries(
    Object.entries(files)
      .filter(([key]) => /\.(zarray|zgroup|zattrs)$/.test(key))
      .map(([key, bytes]) => [key, JSON.parse(new TextDecoder().decode(bytes))])
  );
  files['.zmetadata'] = json({ zarr_consolidated_format: 1, metadata });
  const requested: string[] = [];
  const store: zarr.AsyncReadable = {
    async get(key) {
      requested.push(key);
      return files[key.slice(1)];
    },
  };
  return { store, requested };
}

describe('openExtraConsolidated on consolidated v2 metadata', () => {
  it('misses on zarr.json once, then reads the tree without asking the store for any node file', async () => {
    const { store, requested } = consolidatedV2();
    const result = await openExtraConsolidated(store);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(getNodeAttrs(result.value.tree)).toEqual({ title: 'per-node' });
    // The single v3 attempt before falling back to v2; nothing per node.
    expect(requested.filter((key) => key.endsWith('zarr.json'))).toEqual(['/zarr.json']);
    expect(requested.filter((key) => /\.(zarray|zgroup|zattrs)$/.test(key))).toEqual([]);
  });
});
