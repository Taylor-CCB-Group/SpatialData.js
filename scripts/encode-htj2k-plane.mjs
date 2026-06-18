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
    join(repoRoot, 'node_modules', '@cornerstonejs', 'codec-openjph'),
    join(repoRoot, 'packages', 'zarrextra', 'node_modules', '@cornerstonejs', 'codec-openjph'),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'dist', 'openjphjs.js'))) {
      return candidate;
    }
  }
  throw new Error(
    'Could not find @cornerstonejs/codec-openjph. Install monorepo dependencies with pnpm install.'
  );
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
  const openjphRoot = resolveOpenJphRoot();
  const mod = await import(pathToFileURL(join(openjphRoot, 'dist/openjphjs.js')).href);
  const factory = mod.default ?? mod.OpenJPHJS ?? mod;
  if (typeof factory !== 'function') {
    throw new Error('Could not load OpenJPH WASM factory.');
  }
  const wasmPath = join(openjphRoot, 'dist/openjphjs.wasm');
  return await factory({
    locateFile: (path) => (path.endsWith('.wasm') ? wasmPath : path),
  });
}

async function encodePlane(runtime, request) {
  const Encoder = runtime.HTJ2KEncoder;
  if (!Encoder) {
    throw new Error('OpenJPH runtime does not expose HTJ2KEncoder.');
  }

  const { width, height, dtype } = request;
  const reversible = request.reversible ?? true;
  const quality = request.quality ?? 0;
  const planeBytes = Buffer.from(request.plane, 'base64');
  const plane = planeArrayForDtype(dtype, planeBytes);
  const expectedValues = width * height;
  if (plane.length !== expectedValues) {
    throw new Error(`Plane has ${plane.length} samples, expected ${expectedValues}.`);
  }

  const frame = {
    width,
    height,
    bitsPerSample: dtype === 'uint8' || dtype === 'int8' ? 8 : 16,
    isSigned: dtype === 'int8' || dtype === 'int16',
    componentCount: 1,
    isUsingColorTransform: false,
  };

  const encoder = new Encoder();
  encoder.setQuality(reversible, quality);
  const buffer = encoder.getDecodedBuffer(frame);
  const target =
    frame.bitsPerSample === 16
      ? new Uint16Array(buffer.buffer, buffer.byteOffset, plane.length)
      : new Uint8Array(buffer.buffer, buffer.byteOffset, plane.length);
  target.set(plane);
  encoder.encode();
  return encoder.getEncodedBuffer();
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
