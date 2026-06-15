import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileSystemStore } from '@zarrita/storage';
import { describe, expect, it } from 'vitest';
import { readZarr } from '../../packages/core/src/store/index.js';
import {
  loadOmeZarrMultiscalesFromStore,
  registerJpeg2kCodec,
} from '../../packages/zarrextra/src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '../..');
const uvCacheDir = join(projectRoot, '.tmp', 'uv-cache');
const fixtureDir = join(projectRoot, 'test-fixtures', 'codecs');
const fixturePath = join(fixtureDir, 'jpeg2k.zarr');
const manifestPath = join(fixtureDir, 'jpeg2k.manifest.json');

function ensureCodecFixture() {
  if (existsSync(fixturePath) && existsSync(manifestPath)) {
    return;
  }
  mkdirSync(uvCacheDir, { recursive: true });
  execSync(
    `uv run --directory python/spatialdata-codec-writer spatialdata-codec-writer generate-fixtures --output-dir ${JSON.stringify(fixtureDir)} --overwrite`,
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

    const sdata = await readZarr(new FileSystemStore(fixturePath));
    expect(sdata.images).toBeDefined();
    expect(sdata.images?.codec_image).toBeDefined();
    expect(sdata.images?.codec_image.scaleLevels).toEqual(['0', '1']);

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.codec).toBe('imagecodecs_jpeg2k');
    expect(manifest.shape).toEqual([1, 1, 1, 64, 64]);
  }, 180000);

  it('reports unknown codec before JPEG2K registration', async () => {
    ensureCodecFixture();

    const sdata = await readZarr(new FileSystemStore(fixturePath));
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
    const sdata = await readZarr(new FileSystemStore(fixturePath));
    const image = sdata.images?.codec_image;
    expect(image).toBeDefined();
    if (!image) throw new Error('Expected codec_image to be available.');
    const [source] = await loadOmeZarrMultiscalesFromStore(image.getStore());
    const tile = await source.getTile({ x: 0, y: 0, selection: { t: 0, c: 0, z: 0 } });
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

    expect(tile.width).toBe(32);
    expect(tile.height).toBe(32);
    expect(Number((tile.data as Uint16Array)[0])).toBe(manifest.chunks_checked[0].samples[0]);
  }, 180000);
});
