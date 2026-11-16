#!/usr/bin/env node
/**
 * Build the vis demo as the static viewer that `sdjs serve` ships, into the given
 * directory: packages/cli/app for npm, python/sdjs/src/sdjs/app for PyPI.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: build-viewer-app.mjs <outDir>');
  process.exit(2);
}
const visDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'vis');
const vite = join(visDir, 'node_modules', 'vite', 'bin', 'vite.js');
const result = spawnSync(
  process.execPath,
  [vite, 'build', '--config', 'vite.config.demo.ts', '--outDir', resolve(outDir), '--emptyOutDir'],
  { cwd: visDir, stdio: 'inherit' }
);
process.exit(result.status ?? 1);
