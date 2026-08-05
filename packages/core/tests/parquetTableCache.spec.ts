import { tableFromArrays, tableToIPC } from 'apache-arrow';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SpatialDataTableSource from '../src/models/VTableSource.js';
import type { ParquetCacheLimits } from '../src/Vutils.js';

const PARQUET_PATH = 'points/cells/points.parquet';
const OTHER_PARQUET_PATH = 'points/nuclei/points.parquet';
/** Length of the stub file bytes below — the unit the encoded-tier tests count in. */
const PARQUET_BYTE_LENGTH = 12;

function createParquetBytes() {
  return new Uint8Array([0x50, 0x41, 0x52, 0x31, 0x00, 0x00, 0x00, 0x00, 0x50, 0x41, 0x52, 0x31]);
}

/**
 * A parquet module whose `readParquet` returns a fixed three-row table.
 *
 * `readMetadata` is deliberately absent: without it `loadParquetDatasetMetadata`
 * short-circuits to `null`, so these tests exercise the single-file path through
 * `loadParquetBytes` without needing range support or real WASM.
 */
function createParquetModuleStub() {
  const ipcBytes = tableToIPC(tableFromArrays({ x: Float32Array.from([1, 2, 3]) }));
  const wasmTable = { intoIPCStream: () => ipcBytes };
  return {
    readParquet: vi.fn(() => wasmTable),
    readSchema: vi.fn(() => wasmTable),
    // biome-ignore lint/suspicious/noExplicitAny: test double for the WASM module surface
  } as any;
}

/**
 * A store serving parquet bytes at both test paths, failing the first `failures`
 * reads of {@link PARQUET_PATH}.
 */
function createFlakyStore(failures = 0) {
  let remainingFailures = failures;
  const get = vi.fn(async (path: string) => {
    if (path === `/${PARQUET_PATH}`) {
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        throw new Error('transient network failure');
      }
      return createParquetBytes();
    }
    if (path === `/${OTHER_PARQUET_PATH}`) {
      return createParquetBytes();
    }
    return null;
  });
  return { get };
}

function createSource(store: { get: ReturnType<typeof vi.fn> }, limits?: ParquetCacheLimits) {
  return new SpatialDataTableSource({
    // biome-ignore lint/suspicious/noExplicitAny: minimal zarr.Readable test double
    store: store as any,
    fileType: '.zarr',
    parquetCacheLimits: limits,
  });
}

describe('SpatialDataTableSource parquet table cache', () => {
  beforeEach(() => {
    SpatialDataTableSource.parquetModulePromise = Promise.resolve(createParquetModuleStub());
  });

  it('does not poison the cache with a rejected promise after a transient failure', async () => {
    const store = createFlakyStore(1);
    const source = createSource(store);

    await expect(source.loadParquetTable(PARQUET_PATH)).rejects.toThrow(
      'Failed to load parquet data from store.'
    );
    expect(source.parquetTableCache.size).toBe(0);

    // The store works now. A retry must reach it again rather than replaying the
    // cached rejection for the lifetime of the source.
    const table = await source.loadParquetTable(PARQUET_PATH);
    expect(table.numRows).toBe(3);
    expect(store.get).toHaveBeenCalledWith(`/${PARQUET_PATH}`);
  });

  it('still dedupes concurrent unfiltered reads onto one decode', async () => {
    const source = createSource(createFlakyStore());

    const [first, second] = await Promise.all([
      source.loadParquetTable(PARQUET_PATH),
      source.loadParquetTable(PARQUET_PATH),
    ]);

    expect(first).toBe(second);
  });

  it('keeps a successful table cached across sequential reads', async () => {
    const source = createSource(createFlakyStore());

    const first = await source.loadParquetTable(PARQUET_PATH);
    const second = await source.loadParquetTable(PARQUET_PATH);

    expect(first).toBe(second);
  });

  it('reports resident bytes for both tiers', async () => {
    const source = createSource(createFlakyStore());
    expect(source.parquetTableBytes.byteLength).toBe(0);
    expect(source.parquetTableCache.byteLength).toBe(0);

    await source.loadParquetTable(PARQUET_PATH);

    expect(source.parquetTableBytes.byteLength).toBe(PARQUET_BYTE_LENGTH);
    // Three float32 values plus Arrow's own buffers — the exact figure is Arrow's
    // business; that it is counted at all is the point of ADR 0005 rung 1.
    expect(source.parquetTableCache.byteLength).toBeGreaterThan(0);
  });

  it('bounds the encoded tier, and refetches what it evicted', async () => {
    const store = createFlakyStore();
    const source = createSource(store, { encodedMaxBytes: PARQUET_BYTE_LENGTH });

    await source.loadParquetBytes(PARQUET_PATH);
    expect(source.parquetTableBytes.byteLength).toBe(PARQUET_BYTE_LENGTH);

    await source.loadParquetBytes(OTHER_PARQUET_PATH);
    expect(source.parquetTableBytes.byteLength).toBe(PARQUET_BYTE_LENGTH);
    expect(source.parquetTableBytes.has(PARQUET_PATH)).toBe(false);

    store.get.mockClear();
    await expect(source.loadParquetBytes(PARQUET_PATH)).resolves.toBeInstanceOf(Uint8Array);
    expect(store.get).toHaveBeenCalledWith(`/${PARQUET_PATH}`);
  });

  it('bounds the decoded tier', async () => {
    // One byte: every table is oversized, so each admission evicts the last.
    const source = createSource(createFlakyStore(), { decodedMaxBytes: 1 });

    await source.loadParquetTable(PARQUET_PATH);
    await source.loadParquetTable(OTHER_PARQUET_PATH);

    expect(source.parquetTableCache.size).toBe(1);
    expect(source.parquetTableCache.has(OTHER_PARQUET_PATH)).toBe(true);
  });
});
