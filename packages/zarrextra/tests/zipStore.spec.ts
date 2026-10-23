import { createServer, type Server } from 'node:http';
import { zipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { getNodeAttrs, openExtraConsolidated, type ZipByteReader, ZipStore } from '../src/index';
import { encoder, json, readValues, VALUES, v2Files, v3Files } from './zarrFixtures';

/** STORED entries, as zarr writers produce: chunks are already compressed. */
const zip = (files: Record<string, Uint8Array>) => zipSync(files, { level: 0 });

async function openTree(store: ZipStore) {
  const result = await openExtraConsolidated(store);
  if (!result.ok) throw result.error;
  return result.value;
}

describe('ZipStore', () => {
  it('opens a v2 archive without consolidated metadata by listing its entries', async () => {
    const store = await ZipStore.open(new Blob([zip(v2Files())]));
    const { tree, zarritaStore } = await openTree(store);

    expect(getNodeAttrs(tree)).toEqual({ title: 'per-node' });
    expect('values' in tree).toBe(true);
    expect(await readValues(zarritaStore)).toEqual(VALUES);
  });

  it('opens a v3 archive without consolidated metadata', async () => {
    const store = await ZipStore.open(new Blob([zip(await v3Files())]));
    const { tree, zarritaStore } = await openTree(store);

    expect(getNodeAttrs(tree)).toEqual({ title: 'v3' });
    expect(await readValues(zarritaStore)).toEqual(VALUES);
  });

  it('prefers consolidated metadata over listing when the archive has it', async () => {
    const files = v2Files();
    files['.zmetadata'] = json({
      zarr_consolidated_format: 1,
      metadata: {
        '.zgroup': { zarr_format: 2 },
        '.zattrs': { title: 'consolidated' },
        'values/.zarray': JSON.parse(new TextDecoder().decode(files['values/.zarray'])),
      },
    });
    const { tree } = await openTree(await ZipStore.open(new Blob([zip(files)])));

    expect(getNodeAttrs(tree)).toEqual({ title: 'consolidated' });
  });

  it('roots the store at a single zipped .zarr folder, ignoring __MACOSX entries', async () => {
    const files: Record<string, Uint8Array> = { '__MACOSX/store.zarr/._.zattrs': json({}) };
    for (const [name, bytes] of Object.entries(v2Files())) {
      files[`store.zarr/${name}`] = bytes;
    }
    const { tree, zarritaStore } = await openTree(await ZipStore.open(new Blob([zip(files)])));

    expect(getNodeAttrs(tree)).toEqual({ title: 'per-node' });
    expect(await readValues(zarritaStore)).toEqual(VALUES);
  });

  it('range-reads into an entry without reading the rest of the archive', async () => {
    const files = v2Files();
    files.padding = new Uint8Array(1 << 20);
    const archive = zip(files);
    let bytesRead = 0;
    const reader: ZipByteReader = {
      getLength: async () => archive.length,
      read: async (offset, length) => {
        bytesRead += length;
        return archive.slice(offset, offset + length);
      },
    };
    const store = await ZipStore.open(reader);
    bytesRead = 0;

    const chunk = new Float32Array(VALUES.slice(4));
    const middle = await store.getRange('/values/1', { offset: 4, length: 8 });
    const tail = await store.getRange('/values/1', { suffixLength: 4 });

    expect(middle).toEqual(new Uint8Array(chunk.buffer, 4, 8));
    expect(tail).toEqual(new Uint8Array(chunk.buffer, 12, 4));
    expect(bytesRead).toBeLessThan(1024);
  });

  it("reads an entry's local header once, then one read per range", async () => {
    const archive = zip(v2Files());
    let reads = 0;
    const store = await ZipStore.open({
      getLength: async () => archive.length,
      read: async (offset, length) => {
        reads += 1;
        return archive.slice(offset, offset + length);
      },
    });
    await store.getRange('/values/0', { offset: 0, length: 4 });
    reads = 0;

    await store.getRange('/values/0', { offset: 4, length: 4 });
    await store.getRange('/values/0', { suffixLength: 4 });

    expect(reads).toBe(2);
  });

  it('rejects bytes that are not a zip archive', async () => {
    await expect(ZipStore.open(new Blob([encoder.encode('not a zip')]))).rejects.toThrow();
  });

  describe('over HTTP', () => {
    let server: Server | undefined;
    afterEach(() => server?.close());

    async function serve(archive: Uint8Array, honourRange: boolean): Promise<string> {
      server = createServer((req, res) => {
        const range = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? '');
        if (req.method === 'HEAD') {
          // No Content-Length, as a cross-origin response that does not expose
          // it would look: the size has to come from Content-Range instead.
          res.writeHead(200).end();
        } else if (honourRange && range) {
          const [start, end] = [Number(range[1]), Number(range[2])];
          res
            .writeHead(206, { 'content-range': `bytes ${start}-${end}/${archive.length}` })
            .end(archive.subarray(start, end + 1));
        } else {
          res.writeHead(200).end(archive);
        }
      });
      await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('server is not listening');
      return `http://127.0.0.1:${address.port}/store.zip`;
    }

    it('opens and reads an archive from a server that honours Range', async () => {
      const url = await serve(zip(v2Files()), true);
      const { zarritaStore } = await openTree(await ZipStore.open(url));

      expect(await readValues(zarritaStore)).toEqual(VALUES);
    });

    it('refuses a server that ignores Range rather than misreading the whole file', async () => {
      const url = await serve(zip(v2Files()), false);

      await expect(ZipStore.open(url)).rejects.toThrow(/honours Range/);
    });
  });
});
