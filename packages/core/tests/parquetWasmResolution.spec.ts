/**
 * Packaging guard: the vendored parquet-wasm glue must be reachable from a chunk
 * this package does not control the location of.
 *
 * The loader used to import it by relative path behind a `/* @vite-ignore *\/`.
 * Both halves shipped: the comment told the consumer's bundler to skip resolution,
 * and the literal `../vendor/parquet-wasm/parquet_wasm.js` stayed in the chunk. A
 * consumer's build inlines that chunk into its own `assets/`, where the path means
 * `{root}/vendor/...` — a file no build emitted. Every production build 404d on it
 * while dev worked, because a dev server serves core's `vendor/` tree out of
 * node_modules (MDV#539 had to copy the tree into its output to compensate).
 *
 * The fix is a package subpath, `@spatialdata/core/parquet-wasm`, which resolves
 * through `exports` from wherever the chunk lands. These tests pin both ends: the
 * subpath really loads here, and nothing relative or `@vite-ignore`d is left in
 * what we publish.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getParquetModule } from '../src/parquetWasmLoader.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = resolve(packageRoot, 'dist');

/** Every JS file the build wrote, source maps excluded. */
function distChunks(): string[] {
  return readdirSync(distDir)
    .filter((name) => /\.(js|cjs)$/.test(name))
    .map((name) => resolve(distDir, name));
}

describe('vendored parquet-wasm resolution', () => {
  it('loads the module through the package subpath, with the row-group APIs', async () => {
    const parquet = await getParquetModule();
    expect(typeof parquet.readParquet).toBe('function');
    expect(typeof parquet.readSchema).toBe('function');
    // The reason this build is vendored at all: parquet-wasm@0.6.1 has neither.
    expect(typeof parquet.readMetadata).toBe('function');
    expect(typeof parquet.readParquetRowGroup).toBe('function');
  });

  it('names the subpath in exports, pointing at a file that is published', () => {
    const packageJson = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as {
      files: string[];
      exports: Record<string, Record<string, string>>;
    };
    const target = packageJson.exports['./parquet-wasm']?.default;
    expect(target).toBe('./vendor/parquet-wasm/parquet_wasm.js');
    expect(existsSync(resolve(packageRoot, target))).toBe(true);
    // `files` decides what npm actually ships; `exports` alone would resolve to nothing.
    expect(packageJson.files).toContain('vendor');
  });

  it('leaves no unresolvable vendor path or @vite-ignore in the built chunks', (ctx) => {
    if (!existsSync(distDir)) return ctx.skip();
    const offenders: string[] = [];
    for (const chunk of distChunks()) {
      const source = readFileSync(chunk, 'utf8');
      // The `_bg.wasm` sibling is deliberately absent from this check: it is read
      // from disk by `initSync` under Node, not fetched by a browser, and it
      // resolves against the published layout rather than a bundler's output.
      if (source.includes('vendor/parquet-wasm/parquet_wasm.js')) {
        offenders.push(`${chunk} imports the glue by path instead of by subpath`);
      }
      // Narrow to the *wasm* specifier. The worker client carries its own
      // (separate, deliberate) `@vite-ignore` on `new Worker(new URL(...))`, and
      // since that URL is now `./parquet-worker.js`, a bare `parquet` here matches it.
      if (/@vite-ignore[\s\S]{0,200}parquet[_-]wasm/.test(source)) {
        offenders.push(`${chunk} suppresses resolution of the parquet-wasm import`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('keeps the subpath external, so the wasm is not inlined as base64', (ctx) => {
    if (!existsSync(distDir)) return ctx.skip();
    const chunks = distChunks().map((chunk) => readFileSync(chunk, 'utf8'));
    expect(
      chunks.some((source) => source.includes('@spatialdata/core/parquet-wasm')),
      'no chunk imports the glue by subpath; the loader must not be tree-shaken away'
    ).toBe(true);
    // `build.lib` inlines every asset regardless of `assetsInlineLimit`, so bundling
    // the glue turns a 6.6MB wasm into an 8.8MB base64 chunk, once per format.
    expect(chunks.some((source) => source.includes('data:application/wasm;base64'))).toBe(false);
  });
});
