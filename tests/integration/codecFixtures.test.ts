import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileSystemStore } from '@zarrita/storage';
import { describe, expect, it } from 'vitest';
import { readZarr } from '../../packages/core/src/store/index.js';
import {
  loadOmeZarrMultiscalesFromStore,
  registerExperimentalHtj2kCodec,
  registerJpeg2kCodec,
} from '../../packages/zarrextra/src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '../..');
const uvCacheDir = join(projectRoot, '.tmp', 'uv-cache');
const fixtureDir = join(projectRoot, 'test-fixtures', 'codecs');
const jpeg2kFixturePath = join(fixtureDir, 'jpeg2k.zarr');
const jpeg2kManifestPath = join(fixtureDir, 'jpeg2k.manifest.json');
const mandelbulbFixturePath = join(fixtureDir, 'mandelbulb.zarr');
const mandelbulbManifestPath = join(fixtureDir, 'mandelbulb.manifest.json');
const htj2kFixturePath = join(fixtureDir, 'htj2k.zarr');
const htj2kManifestPath = join(fixtureDir, 'htj2k.manifest.json');

function ensureCodecFixture() {
  const hasJpeg2k = existsSync(jpeg2kFixturePath) && existsSync(jpeg2kManifestPath);
  const hasMandelbulb = existsSync(mandelbulbFixturePath) && existsSync(mandelbulbManifestPath);
  if (hasJpeg2k && hasMandelbulb) {
    return;
  }
  mkdirSync(uvCacheDir, { recursive: true });
  execSync(
    `node scripts/vendor-openjph-for-python.mjs && uv run --directory python/spatialdata-codec-writer python scripts/generate_codec_fixtures.py --output-dir ${JSON.stringify(fixtureDir)} --experimental-htj2k --overwrite`,
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        UV_CACHE_DIR: uvCacheDir,
      },
      stdio: 'inherit',
    }
  );
}

describe('codec fixtures', () => {
  it('generates a Python reference fixture that readZarr can parse', async () => {
    ensureCodecFixture();

    const sdata = await readZarr(new FileSystemStore(jpeg2kFixturePath));
    expect(sdata.images).toBeDefined();
    expect(sdata.images?.codec_image).toBeDefined();
    expect(sdata.images?.codec_image.scaleLevels).toEqual(['0', '1']);

    const manifest = JSON.parse(readFileSync(jpeg2kManifestPath, 'utf8'));
    expect(manifest.codec).toBe('imagecodecs_jpeg2k');
    expect(manifest.shape).toEqual([1, 1, 1, 64, 64]);
  }, 180000);

  it('reports unknown codec before JPEG2K registration', async () => {
    ensureCodecFixture();

    const sdata = await readZarr(new FileSystemStore(jpeg2kFixturePath));
    const store = sdata.images?.codec_image.getStore();
    expect(store).toBeDefined();
    if (!store) throw new Error('Expected codec_image store to be available.');
    const [source] = await loadOmeZarrMultiscalesFromStore(store);
    await expect(source.getTile({ x: 0, y: 0, selection: { t: 0, c: 0, z: 0 } })).rejects.toThrow(
      /Unknown codec/
    );
  }, 180000);

  it('can decode the JP2K fixture when the optional WASM decoder is installed', async () => {
    ensureCodecFixture();
    try {
      await import('@cornerstonejs/codec-openjpeg/decode');
    } catch {
      console.warn(
        'Skipping JP2K decode smoke test: @cornerstonejs/codec-openjpeg is not installed.'
      );
      return;
    }

    registerJpeg2kCodec();
    const sdata = await readZarr(new FileSystemStore(jpeg2kFixturePath));
    const image = sdata.images?.codec_image;
    expect(image).toBeDefined();
    if (!image) throw new Error('Expected codec_image to be available.');
    const [source] = await loadOmeZarrMultiscalesFromStore(image.getStore());
    const tile = await source.getTile({ x: 0, y: 0, selection: { t: 0, c: 0, z: 0 } });
    const manifest = JSON.parse(readFileSync(jpeg2kManifestPath, 'utf8'));

    expect(tile.width).toBe(32);
    expect(tile.height).toBe(32);
    expect(Number((tile.data as Uint16Array)[0])).toBe(manifest.chunks_checked[0].samples[0]);
  }, 180000);

  it('can decode the Mandelbulb HTJ2K fixture across t/z selections', async () => {
    ensureCodecFixture();
    if (!existsSync(mandelbulbFixturePath) || !existsSync(mandelbulbManifestPath)) {
      console.warn(
        'Skipping Mandelbulb HTJ2K decode smoke test: mandelbulb.zarr was not generated (OpenJPH WASM encoder unavailable).'
      );
      return;
    }
    try {
      await import('openjph-wasm');
    } catch {
      console.warn(
        'Skipping Mandelbulb HTJ2K decode smoke test: openjph-wasm is not installed.'
      );
      return;
    }

    registerExperimentalHtj2kCodec();
    const sdata = await readZarr(new FileSystemStore(mandelbulbFixturePath));
    const image = sdata.images?.mandelbulb;
    expect(image).toBeDefined();
    if (!image) throw new Error('Expected mandelbulb image to be available.');

    const manifest = JSON.parse(readFileSync(mandelbulbManifestPath, 'utf8'));
    expect(manifest.codec).toBe('experimental.openjph_htj2k');
    expect(manifest.shape).toEqual([2, 1, 8, 128, 128]);

    const [source] = await loadOmeZarrMultiscalesFromStore(image.getStore());
    expect(source.shape).toEqual([2, 1, 8, 128, 128]);

    const tileTz0 = await source.getTile({ x: 0, y: 0, selection: { t: 0, c: 0, z: 0 } });
    const tileTz1 = await source.getTile({ x: 0, y: 0, selection: { t: 1, c: 0, z: 2 } });

    expect(tileTz0.width).toBe(128);
    expect(tileTz0.height).toBe(128);
    expect(Number((tileTz0.data as Uint16Array)[0])).toBe(manifest.chunks_checked[0].samples[0]);
    expect(Number((tileTz1.data as Uint16Array)[0])).not.toBe(
      Number((tileTz0.data as Uint16Array)[0])
    );
  }, 180000);

  it('can decode the HTJ2K fixture when the optional WASM decoder is installed', async () => {
    ensureCodecFixture();
    if (!existsSync(htj2kFixturePath) || !existsSync(htj2kManifestPath)) {
      console.warn(
        'Skipping HTJ2K decode smoke test: htj2k.zarr was not generated (OpenJPH WASM encoder unavailable).'
      );
      return;
    }
    try {
      await import('openjph-wasm');
    } catch {
      console.warn(
        'Skipping HTJ2K decode smoke test: openjph-wasm is not installed.'
      );
      return;
    }

    registerExperimentalHtj2kCodec();
    const sdata = await readZarr(new FileSystemStore(htj2kFixturePath));
    const image = sdata.images?.codec_image;
    expect(image).toBeDefined();
    if (!image) throw new Error('Expected codec_image to be available.');
    const [source] = await loadOmeZarrMultiscalesFromStore(image.getStore());
    const tile = await source.getTile({ x: 0, y: 0, selection: { t: 0, c: 0, z: 0 } });
    const manifest = JSON.parse(readFileSync(htj2kManifestPath, 'utf8'));

    expect(tile.width).toBe(32);
    expect(tile.height).toBe(32);
    expect(Number((tile.data as Uint16Array)[0])).toBe(manifest.chunks_checked[0].samples[0]);
  }, 180000);
});
