#!/usr/bin/env node
/**
 * Copy @cornerstonejs/codec-openjph dist assets into spatialdata-codec-writer
 * package data for standalone pip installs (no monorepo checkout required).
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function resolveOpenJphRoot() {
  const candidates = [
    join(repoRoot, 'node_modules', '@cornerstonejs', 'codec-openjph'),
    join(repoRoot, 'packages', 'zarrextra', 'node_modules', '@cornerstonejs', 'codec-openjph'),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'dist', 'openjphjs.js'))) {
      return candidate;
    }
  }
  throw new Error(
    'Could not find @cornerstonejs/codec-openjph. Run pnpm install at the repository root.'
  );
}

const openjphRoot = resolveOpenJphRoot();
const vendorRoot = join(
  repoRoot,
  'python',
  'spatialdata-codec-writer',
  'src',
  'spatialdata_codec_writer',
  'vendor',
  'openjph'
);
mkdirSync(vendorRoot, { recursive: true });

for (const name of ['openjphjs.js', 'openjphjs.wasm']) {
  const source = join(openjphRoot, 'dist', name);
  const dest = join(vendorRoot, name);
  copyFileSync(source, dest);
  console.log(`Vendored ${name} -> ${dest}`);
}
