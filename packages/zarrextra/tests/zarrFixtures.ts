import * as zarr from 'zarrita';

export const encoder = new TextEncoder();
export const json = (value: unknown) => encoder.encode(JSON.stringify(value));
export const VALUES = [1, 2, 3, 4, 5, 6, 7, 8];

/** A two-chunk float32 array under a group, written the way zarr-python v2 does. */
export function v2Files(): Record<string, Uint8Array> {
  return {
    '.zgroup': json({ zarr_format: 2 }),
    '.zattrs': json({ title: 'per-node' }),
    'values/.zarray': json({
      zarr_format: 2,
      shape: [8],
      chunks: [4],
      dtype: '<f4',
      compressor: null,
      filters: null,
      fill_value: 0,
      order: 'C',
    }),
    'values/0': new Uint8Array(new Float32Array(VALUES.slice(0, 4)).buffer),
    'values/1': new Uint8Array(new Float32Array(VALUES.slice(4)).buffer),
  };
}

export async function v3Files(): Promise<Record<string, Uint8Array>> {
  const map = new Map<zarr.AbsolutePath, Uint8Array>();
  const root = await zarr.create(zarr.root(map), { attributes: { title: 'v3' } });
  const values = await zarr.create(root.resolve('values'), {
    shape: [8],
    chunkShape: [4],
    dtype: 'float32',
  });
  await zarr.set(values, null, { data: new Float32Array(VALUES), shape: [8], stride: [1] });
  return Object.fromEntries([...map].map(([key, bytes]) => [key.slice(1), bytes]));
}

export async function readValues(store: zarr.Readable): Promise<number[]> {
  const values = await zarr.open(zarr.root(store).resolve('values'), { kind: 'array' });
  const { data } = await zarr.get(values);
  if (!(data instanceof Float32Array)) throw new Error('expected float32 values');
  return Array.from(data);
}
