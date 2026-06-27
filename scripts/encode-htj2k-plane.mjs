#!/usr/bin/env node
/**
 * Encode one 2D image plane to HTJ2K for Python spatialdata-codec-writer.
 *
 * stdin: JSON { width, height, dtype, reversible?, quality?, plane: base64 }
 * stdout: raw HTJ2K bytes
 * stderr: errors
 */
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

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
  throw new Error('Could not find openjph-wasm. Install monorepo dependencies with pnpm install.');
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function planeArrayForDtype(dtype, bytes) {
  switch (dtype) {
    case 'uint8':
      return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    case 'int8':
      return new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    case 'uint16':
      return new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
    case 'int16':
      return new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
    default:
      throw new Error(`Unsupported plane dtype '${dtype}'.`);
  }
}

async function loadEncoder() {
  const indexPath = join(resolveOpenJphRoot(), 'dist', 'index.js');
  const mod = await import(pathToFileURL(indexPath).href);
  if (typeof mod.encode !== 'function') {
    throw new Error('openjph-wasm does not expose encode().');
  }
  return mod;
}

async function encodePlane(runtime, request) {
  const { width, height, dtype } = request;
  const reversible = request.reversible ?? true;
  const quality = request.quality ?? 0;
  const planeBytes = Buffer.from(request.plane, 'base64');
  const plane = planeArrayForDtype(dtype, planeBytes);
  const expectedValues = width * height;
  if (plane.length !== expectedValues) {
    throw new Error(`Plane has ${plane.length} samples, expected ${expectedValues}.`);
  }

  // bitDepth / isSigned are inferred from the typed array by openjph-wasm.
  const input = { data: plane, width, height, components: 1, reversible };
  if (!reversible) {
    input.quality = quality;
  }
  return await runtime.encode(input);
}

async function main() {
  const runtime = await loadEncoder();
  const request = JSON.parse((await readStdin()).toString('utf8'));
  const encoded = await encodePlane(runtime, request);
  process.stdout.write(Buffer.from(encoded));
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
