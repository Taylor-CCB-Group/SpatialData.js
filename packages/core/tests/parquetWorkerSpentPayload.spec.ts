import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decodeShapesGeometryInWorker,
  disableParquetWorker,
  enableParquetWorker,
  setParquetWorkerRequestTimeout,
} from '../src/workers/parquetWorkerClient.js';

/**
 * A payload whose buffers an earlier request already TRANSFERRED.
 *
 * Transferring is what makes a whole-part payload affordable — 100MB+ on a points
 * element — and it detaches the buffer here. Hand the same bytes over twice and the
 * second `postMessage` is refused before the worker sees anything, which is how the
 * points preload's last fallback failed with `DataCloneError: ArrayBuffer at index 0
 * is already detached`: no request type, no path, and phrased as a worker fault.
 *
 * The browser refuses the post; this fake has to be told to, because a plain object
 * `postMessage` clones nothing.
 */
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  posted: unknown[] = [];

  constructor() {
    FakeWorker.instances.push(this);
  }
  postMessage(message: unknown, transfer?: Transferable[]) {
    for (const item of transfer ?? []) {
      // A spent buffer carries no bytes, which is the part of `detached` that is
      // safe to lean on here: `ArrayBuffer.prototype.detached` is ES2024, this
      // package's `lib` is ES2022, and the tsconfig does not cover `tests/` — so a
      // reference to it is unchecked, and on a runtime without it the fake would
      // quietly accept the post and the test would assert nothing.
      if (item instanceof ArrayBuffer && item.byteLength === 0) {
        throw new DOMException(
          "Failed to execute 'postMessage' on 'Worker': ArrayBuffer at index 0 is already detached.",
          'DataCloneError'
        );
      }
    }
    this.posted.push(message);
  }
  terminate() {}
  signalReady() {
    this.onmessage?.({ data: { id: -1, direction: 'ready' } });
  }
}

/** Bytes that have genuinely been given away, as a transfer to the worker does. */
function spentBytes(): Uint8Array {
  const bytes = new Uint8Array(8);
  structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
  return bytes;
}

function startWorker() {
  FakeWorker.instances = [];
  vi.stubGlobal('Worker', FakeWorker);
  enableParquetWorker({ createWorker: () => new FakeWorker() as unknown as Worker });
  FakeWorker.instances[0]?.signalReady();
}

afterEach(() => {
  disableParquetWorker();
  vi.unstubAllGlobals();
  setParquetWorkerRequestTimeout(30_000);
  vi.useRealTimers();
  vi.restoreAllMocks();
  FakeWorker.instances = [];
});

describe('posting a payload whose bytes were already transferred', () => {
  it('rejects saying the bytes are spent, rather than blaming the worker', async () => {
    startWorker();

    await expect(
      decodeShapesGeometryInWorker({
        parts: [spentBytes()],
        geometryColumnName: 'geometry',
        geometryKind: 'polygon',
      })
    ).rejects.toThrow(/already transferred by an earlier request/);
  });

  it('leaves no armed watchdog behind for a request that never left', async () => {
    vi.useFakeTimers();
    setParquetWorkerRequestTimeout(1_000);
    startWorker();

    await expect(
      decodeShapesGeometryInWorker({
        parts: [spentBytes()],
        geometryColumnName: 'geometry',
        geometryKind: 'polygon',
      })
    ).rejects.toThrow();

    // The entry was registered and the watchdog armed a line before the post threw.
    // Left in place it holds a timer for the whole budget, keeps the caller's abort
    // listener alive, and shows up in the set a crash-restart treats as in flight.
    expect(vi.getTimerCount()).toBe(0);
  });
});
