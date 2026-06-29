#!/usr/bin/env node
/**
 * Copy openjph-wasm dist assets into spatialdata-codec-writer package data for
 * standalone pip installs (no monorepo checkout required).
 *
 * Vendors `dist/index.js` and the whole `dist/wasm/` directory so the package's
 * own `new URL("./wasm/libopenjph.mjs", import.meta.url)` resolution keeps
 * working from the vendored copy.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function resolveOpenJphRoot() {
  const candidates = [
    join(repoRoot, 'node_modules', 'openjph-wasm'),
    join(repoRoot, 'packages', 'zarrextra', 'node_modules', 'openjph-wasm'),
    join(repoRoot, 'packages', 'vis', 'node_modules', 'openjph-wasm'),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'dist', 'index.js'))) {
      return candidate;
    }
  }
  throw new Error('Could not find openjph-wasm. Run pnpm install at the repository root.');
}

const distDir = join(resolveOpenJphRoot(), 'dist');
const vendorRoot = join(
  repoRoot,
  'python',
  'spatialdata-codec-writer',
  'src',
  'spatialdata_codec_writer',
  'vendor',
  'openjph'
);
const vendorWasmDir = join(vendorRoot, 'wasm');
mkdirSync(vendorWasmDir, { recursive: true });

const indexSource = join(distDir, 'index.js');
if (!existsSync(indexSource)) {
  throw new Error(`Required openjph-wasm artifact not found: ${indexSource}`);
}
// Vendor as .mjs so Node treats it as ESM (import.meta) without a package.json
// marker in the vendored directory.
const indexDest = join(vendorRoot, 'index.mjs');
copyFileSync(indexSource, indexDest);
console.log(`Vendored index.mjs -> ${indexDest}`);

const wasmSource = join(distDir, 'wasm');
if (!existsSync(wasmSource)) {
  throw new Error(`Required openjph-wasm wasm directory not found: ${wasmSource}`);
}

/** Recursively copy a directory tree, copying files and recreating subdirs. */
function copyTree(srcDir, destDir, relBase) {
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const src = join(srcDir, entry.name);
    const dest = join(destDir, entry.name);
    const rel = `${relBase}/${entry.name}`;
    if (entry.isDirectory()) {
      copyTree(src, dest, rel);
    } else {
      copyFileSync(src, dest);
      console.log(`Vendored ${rel} -> ${dest}`);
    }
  }
}

copyTree(wasmSource, vendorWasmDir, 'wasm');
