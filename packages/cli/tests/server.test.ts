import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveServedRoot } from '../src/catalog.ts';
import { createStoreServer, parseRange } from '../src/server.ts';

let dir: string;
let server: Server;
let base: string;
const TOKEN = 'tok';
const SD_ROOT =
  '{"zarr_format":3,"node_type":"group","attributes":{"spatialdata_attrs":{"version":"0.2"}}}';

async function start(root: string, token: string | null, app: string | null = null) {
  const s = createStoreServer({
    root: await resolveServedRoot(root),
    token,
    appDir: app,
    loopbackOnly: true,
  });
  await new Promise<void>((done) => s.listen(0, '127.0.0.1', done));
  const address = s.address();
  if (typeof address !== 'object' || !address) throw new Error('no address');
  return { server: s, base: `http://127.0.0.1:${address.port}` };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sdjs-'));
  await mkdir(join(dir, 'a.zarr', 'images'), { recursive: true });
  await writeFile(join(dir, 'a.zarr', 'zarr.json'), SD_ROOT);
  await writeFile(join(dir, 'a.zarr', '.zattrs'), '{}');
  await writeFile(join(dir, 'a.zarr', 'images', 'chunk'), Buffer.from('0123456789'));
  // Nested, and a store inside a store is not listed separately.
  await mkdir(join(dir, 'project', 'run 1', 'b.zarr', 'inner.zarr'), { recursive: true });
  await writeFile(join(dir, 'project', 'c.zarr.zip'), 'PK');
  // zarr v2 SpatialData, and a zarr group that is not SpatialData.
  await mkdir(join(dir, 'other', 'v2.zarr'), { recursive: true });
  await writeFile(join(dir, 'other', 'v2.zarr', '.zgroup'), '{"zarr_format":2}');
  await writeFile(join(dir, 'other', 'v2.zarr', '.zattrs'), '{"spatialdata_attrs":{}}');
  await mkdir(join(dir, 'other', 'plain.zarr'), { recursive: true });
  await writeFile(
    join(dir, 'other', 'plain.zarr', 'zarr.json'),
    '{"zarr_format":3,"node_type":"group"}'
  );
  await mkdir(join(dir, '.hidden', 'd.zarr'), { recursive: true });
  await writeFile(join(dir, 'secret.txt'), 'nope');
  // A symlink loop must not hang discovery.
  await symlink(dir, join(dir, 'project', 'loop'));
  await mkdir(join(dir, 'app'));
  await writeFile(join(dir, 'app', 'index.html'), '<html>viewer</html>');
  ({ server, base } = await start(dir, TOKEN, join(dir, 'app')));
});

afterAll(async () => {
  server?.close();
  await rm(dir, { recursive: true, force: true });
});

describe('catalog', () => {
  it('lists nested stores, stopping at each store and skipping hidden dirs', async () => {
    const res = await fetch(`${base}/${TOKEN}/catalog.json`);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const catalog = await res.json();
    expect(catalog).toMatchObject({ version: 1, name: expect.any(String) });
    expect(catalog).toHaveProperty('stores', [
      { path: 'a.zarr', url: 'data/a.zarr', kind: 'spatialdata' },
      { path: 'other/plain.zarr', url: 'data/other/plain.zarr', kind: 'zarr' },
      { path: 'other/v2.zarr', url: 'data/other/v2.zarr', kind: 'spatialdata' },
      // Zips are listed without being inspected.
      { path: 'project/c.zarr.zip', url: 'data/project/c.zarr.zip' },
      { path: 'project/run 1/b.zarr', url: 'data/project/run%201/b.zarr', kind: 'unknown' },
    ]);
  });

  it('is gated by the token', async () => {
    expect((await fetch(`${base}/other/catalog.json`)).status).toBe(404);
    expect((await fetch(`${base}/stores/catalog.json`)).status).toBe(404);
  });

  it('serves a single store given as the root', async () => {
    const single = await start(join(dir, 'a.zarr'), null);
    try {
      const catalog = await (await fetch(`${single.base}/stores/catalog.json`)).json();
      expect(catalog).toHaveProperty('stores', [
        { path: 'a.zarr', url: 'data/a.zarr', kind: 'spatialdata' },
      ]);
      expect((await fetch(`${single.base}/stores/data/a.zarr/zarr.json`)).status).toBe(200);
      expect((await fetch(`${single.base}/stores/data/project/c.zarr.zip`)).status).toBe(404);
    } finally {
      single.server.close();
    }
  });
});

describe('data', () => {
  const data = () => `${base}/${TOKEN}/data`;

  it('serves files inside stores, including dotfiles', async () => {
    expect(await (await fetch(`${data()}/a.zarr/zarr.json`)).text()).toBe(SD_ROOT);
    expect((await fetch(`${data()}/a.zarr/.zattrs`)).status).toBe(200);
    expect((await fetch(`${data()}/project/run%201/b.zarr/inner.zarr`)).status).toBe(404);
  });

  it('refuses anything outside a store', async () => {
    for (const path of [
      'secret.txt',
      'a.zarr/../secret.txt',
      'a.zarr/%2e%2e/secret.txt',
      '.hidden/d.zarr',
    ]) {
      expect((await fetch(`${data()}/${path}`)).status, path).toBe(404);
    }
  });

  it('answers bounded, open-ended and suffix ranges', async () => {
    const get = (range: string) =>
      fetch(`${data()}/a.zarr/images/chunk`, { headers: { Range: range } });
    const bounded = await get('bytes=2-4');
    expect(bounded.status).toBe(206);
    expect(bounded.headers.get('content-range')).toBe('bytes 2-4/10');
    expect(await bounded.text()).toBe('234');
    expect(await (await get('bytes=7-')).text()).toBe('789');
    expect(await (await get('bytes=-3')).text()).toBe('789');
    const beyond = await get('bytes=20-');
    expect(beyond.status).toBe(416);
    expect(beyond.headers.get('content-range')).toBe('bytes */10');
  });

  it('answers HEAD with the size and a preflight that allows Range', async () => {
    const head = await fetch(`${data()}/a.zarr/images/chunk`, { method: 'HEAD' });
    expect(head.headers.get('content-length')).toBe('10');
    const pre = await fetch(`${data()}/a.zarr/images/chunk`, {
      method: 'OPTIONS',
      headers: { 'Access-Control-Request-Private-Network': 'true' },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-headers')).toBe('Range');
    expect(pre.headers.get('access-control-allow-private-network')).toBe('true');
  });
});

describe('app and host', () => {
  it('serves the viewer at / and for extensionless routes', async () => {
    expect(await (await fetch(`${base}/`)).text()).toContain('viewer');
    expect(await (await fetch(`${base}/headless`)).text()).toContain('viewer');
    expect((await fetch(`${base}/missing.js`)).status).toBe(404);
  });

  it('refuses a non-loopback Host header', async () => {
    const { request } = await import('node:http');
    const status = await new Promise<number | undefined>((done) => {
      request(`${base}/`, { headers: { Host: 'evil.example:80' } }, (res) => {
        res.resume();
        done(res.statusCode);
      }).end();
    });
    expect(status).toBe(403);
  });
});

describe('parseRange', () => {
  it('falls back to the whole file for forms it does not support', () => {
    expect(parseRange(undefined, 10)).toBeNull();
    expect(parseRange('bytes=0-1,4-5', 10)).toBeNull();
    expect(parseRange('bytes=-', 10)).toBeNull();
    expect(parseRange('bytes=-20', 10)).toEqual({ start: 0, end: 9 });
  });
});
