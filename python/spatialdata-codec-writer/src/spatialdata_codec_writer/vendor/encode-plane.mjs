#!/usr/bin/env node
import { dirname, join } from 'node:path';
/**
 * Encode/decode HTJ2K chunks via vendored openjph-wasm.
 *
 * A chunk is one or more planar, component-major planes (e.g. z-planes of a
 * volumetric chunk) encoded as a single multi-component codestream.
 *
 * One-shot mode (default): encode only.
 *   stdin: JSON { width, height, components?, dtype, reversible?, quality?, plane: base64 }
 *   stdout: raw HTJ2K bytes
 *
 * Worker mode (--worker):
 *   Repeated length-prefixed requests on stdin; length-prefixed responses on stdout.
 *   Request:  [u32 BE length][JSON utf8]
 *     encode (default): { width, height, components?, dtype, reversible?, quality?, plane: base64 }
 *     decode:           { op: "decode", codestream: base64 }
 *   Response: [u8 status][u32 BE length][payload]
 *     status 0 = payload (encode: HTJ2K bytes; decode: 14-byte header + planar samples)
 *     status 1 = UTF-8 error message
 *
 *   Decode header (little-endian): u32 components, u32 height, u32 width,
 *     u8 bytesPerSample, u8 isSigned — followed by the raw component-major samples.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';

const vendorDir = dirname(fileURLToPath(import.meta.url));
const openjphIndex = join(vendorDir, 'openjph', 'index.mjs');
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

async function loadRuntime() {
  const mod = await import(pathToFileURL(openjphIndex).href);
  if (typeof mod.encode !== 'function' || typeof mod.decode !== 'function') {
    throw new Error('Vendored openjph-wasm does not expose encode()/decode().');
  }
  return mod;
}

async function encodeChunk(runtime, request) {
  const { width, height, dtype } = request;
  const components = request.components ?? 1;
  const reversible = request.reversible ?? true;
  const quality = request.quality ?? 0;
  const planeBytes = Buffer.from(request.plane, 'base64');
  const data = planeArrayForDtype(dtype, planeBytes);
  const expectedValues = width * height * components;
  if (data.length !== expectedValues) {
    throw new Error(`Chunk has ${data.length} samples, expected ${expectedValues}.`);
  }

  // bitDepth / isSigned are inferred from the typed array by openjph-wasm.
  const input = { data, width, height, components, reversible };
  if (!reversible) {
    input.quality = quality;
  }
  return await runtime.encode(input);
}

async function decodeChunk(runtime, request) {
  const codestream = Buffer.from(request.codestream, 'base64');
  const result = await runtime.decode(new Uint8Array(codestream));
  const samples = result.data;
  const bytesPerSample = samples.BYTES_PER_ELEMENT;
  const header = Buffer.alloc(14);
  header.writeUInt32LE(result.components, 0);
  header.writeUInt32LE(result.height, 4);
  header.writeUInt32LE(result.width, 8);
  header.writeUInt8(bytesPerSample, 12);
  header.writeUInt8(result.isSigned ? 1 : 0, 13);
  const body = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  return Buffer.concat([header, body]);
}

async function handleRequest(runtime, request) {
  return request.op === 'decode'
    ? await decodeChunk(runtime, request)
    : await encodeChunk(runtime, request);
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
      const payload = await handleRequest(runtime, request);
      writeResponse(0, Buffer.from(payload));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeResponse(1, Buffer.from(message, 'utf8'));
    }
  }
}

async function runOnce(runtime) {
  const request = JSON.parse((await readStdin()).toString('utf8'));
  const encoded = await encodeChunk(runtime, request);
  process.stdout.write(Buffer.from(encoded));
}

async function main() {
  const runtime = await loadRuntime();
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
