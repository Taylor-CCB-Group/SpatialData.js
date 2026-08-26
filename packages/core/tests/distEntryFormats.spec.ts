/**
 * Packaging guard: every `exports` target must actually be in the module system its
 * extension and the package `type` imply.
 *
 * This exists because the failure mode is completely silent. `parquet-worker` and
 * `workers` were both emitted twice under the same `.js` name (the lib `fileName`
 * ignored `format`), so the cjs pass overwrote the es one and shipped CommonJS under
 * `.js` in a `"type": "module"` package. The build succeeded, the files existed, and
 * the types were right — it only surfaced in a consumer, as
 * `ReferenceError: require is not defined` inside a Worker that then never answered.
 * Nothing in the repo caught it because the demo imports the worker's TS source.
 *
 * Skips when `dist` is absent so a plain `vitest run` on a fresh clone doesn't fail;
 * CI builds before testing, and the assertions run there.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as {
  type?: string;
  exports: Record<string, Record<string, string>>;
};

/** Every JS file named by an `exports` condition, as [condition path, file path]. */
function exportedJsTargets(): Array<{ subpath: string; condition: string; file: string }> {
  const targets: Array<{ subpath: string; condition: string; file: string }> = [];
  for (const [subpath, conditions] of Object.entries(packageJson.exports)) {
    for (const [condition, target] of Object.entries(conditions)) {
      if (condition === 'types') continue;
      if (!/\.(js|cjs|mjs)$/.test(target)) continue;
      targets.push({ subpath, condition, file: resolve(packageRoot, target) });
    }
  }
  return targets;
}

/** CommonJS markers that cannot appear at the top level of an ES module. */
const COMMONJS_PATTERN = /(^|[^.\w])(require\(|exports\.|module\.exports)/;
/** ESM markers that cannot appear in a CommonJS file. */
const ESM_PATTERN = /(^|\n)\s*(import\s|export\s|export\{)/;

describe('published entry formats', () => {
  const targets = exportedJsTargets();

  it('declares the package as an ES module', () => {
    expect(packageJson.type).toBe('module');
  });

  it('names at least the four known entries', () => {
    expect(Object.keys(packageJson.exports).sort()).toEqual([
      '.',
      './parquet-wasm',
      './parquet-worker',
      './workers',
    ]);
  });

  for (const { subpath, condition, file } of targets) {
    const label = `${subpath} (${condition}) -> ${file.slice(packageRoot.length + 1)}`;

    it(`${label} exists`, (ctx) => {
      if (!existsSync(resolve(packageRoot, 'dist'))) return ctx.skip();
      expect(existsSync(file)).toBe(true);
    });

    it(`${label} is in the right module system`, (ctx) => {
      if (!existsSync(file)) return ctx.skip();
      const source = readFileSync(file, 'utf8');
      // `.js` in a `"type": "module"` package is ESM; `.cjs` is always CommonJS.
      const expectsEsm =
        file.endsWith('.mjs') || (file.endsWith('.js') && packageJson.type === 'module');
      if (expectsEsm) {
        expect(
          COMMONJS_PATTERN.test(source),
          `${label} contains CommonJS syntax but must be an ES module. The lib \`fileName\` ` +
            `probably names this entry without its format, so the cjs pass overwrote the es one.`
        ).toBe(false);
      } else {
        expect(ESM_PATTERN.test(source), `${label} must be CommonJS`).toBe(false);
      }
    });
  }

  it('gives the parquet worker an ES module, which is the only thing new Worker({type:"module"}) can load', (ctx) => {
    const worker = resolve(packageRoot, 'dist/parquet-worker.js');
    if (!existsSync(worker)) return ctx.skip();
    const source = readFileSync(worker, 'utf8');
    expect(COMMONJS_PATTERN.test(source)).toBe(false);
    expect(ESM_PATTERN.test(source)).toBe(true);
  });
});
