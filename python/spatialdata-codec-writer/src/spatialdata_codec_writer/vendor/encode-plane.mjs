#!/usr/bin/env node
/**
 * Encode one 2D image plane to HTJ2K via vendored OpenJPH WASM.
 *
 * One-shot mode (default):
 *   stdin: JSON { width, height, dtype, reversible?, quality?, plane: base64 }
 *   stdout: raw HTJ2K bytes
 *
 * Worker mode (--worker):
 *   Repeated length-prefixed requests on stdin; length-prefixed responses on stdout.
 *   Request:  [u32 BE length][JSON utf8]
 *   Response: [u8 status][u32 BE length][payload]
 *     status 0 = HTJ2K bytes
 *     status 1 = UTF-8 error message
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const vendorDir = dirname(fileURLToPath(import.meta.url));
const openjphDir = join(vendorDir, 'openjph');
const workerMode = process.argv.includes('--worker');

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
  const mod = await import(pathToFileURL(join(openjphDir, 'openjphjs.js')).href);
  const factory = mod.default ?? mod.OpenJPHJS ?? mod;
  if (typeof factory !== 'function') {
    throw new Error('Could not load OpenJPH WASM factory.');
  }
  const wasmPath = join(openjphDir, 'openjphjs.wasm');
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

function writeResponse(status, payload) {
  const header = Buffer.alloc(5);
  header.writeUInt8(status, 0);
  header.writeUInt32BE(payload.length, 1);
  process.stdout.write(header);
  if (payload.length > 0) {
    process.stdout.write(payload);
  }
}

async function* readLengthPrefixedJson(stream) {
  let buffer = Buffer.alloc(0);
  for await (const chunk of stream) {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32BE(0);
      if (buffer.length < 4 + length) {
        break;
      }
      const body = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);
      yield JSON.parse(body.toString('utf8'));
    }
  }
}

async function runWorker(runtime) {
  for await (const request of readLengthPrefixedJson(process.stdin)) {
    try {
      const encoded = await encodePlane(runtime, request);
      writeResponse(0, Buffer.from(encoded));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeResponse(1, Buffer.from(message, 'utf8'));
    }
  }
}

async function runOnce(runtime) {
  const request = JSON.parse((await readStdin()).toString('utf8'));
  const encoded = await encodePlane(runtime, request);
  process.stdout.write(Buffer.from(encoded));
}

async function main() {
  const runtime = await loadEncoder();
  if (workerMode) {
    await runWorker(runtime);
    return;
  }
  await runOnce(runtime);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (workerMode) {
    writeResponse(1, Buffer.from(message, 'utf8'));
    process.exit(1);
  }
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
