import { tableFromArrays, tableToIPC } from 'apache-arrow';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SpatialDataTableSource from '../src/models/VTableSource.js';

const PARQUET_PATH = 'points/cells/points.parquet';

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

/** A store that fails `failures` times on the main parquet path, then succeeds. */
function createFlakyStore(failures: number) {
  const parquetBytes = createParquetBytes();
  let remainingFailures = failures;
  const get = vi.fn(async (path: string) => {
    if (path === `/${PARQUET_PATH}`) {
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        throw new Error('transient network failure');
      }
      return parquetBytes;
    }
    return null;
  });
  return { get };
}

function createSource(store: { get: ReturnType<typeof vi.fn> }) {
  return new SpatialDataTableSource({
    // biome-ignore lint/suspicious/noExplicitAny: minimal zarr.Readable test double
    store: store as any,
    fileType: '.zarr',
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

    // The store works now. A retry must reach it again rather than replaying the
    // cached rejection for the lifetime of the source.
    const table = await source.loadParquetTable(PARQUET_PATH);
    expect(table.numRows).toBe(3);
    expect(store.get).toHaveBeenCalledWith(`/${PARQUET_PATH}`);
  });

  it('still dedupes concurrent unfiltered reads onto one decode', async () => {
    const store = createFlakyStore(0);
    const source = createSource(store);

    const [first, second] = await Promise.all([
      source.loadParquetTable(PARQUET_PATH),
      source.loadParquetTable(PARQUET_PATH),
    ]);

    expect(first).toBe(second);
  });

  it('keeps a successful table cached across sequential reads', async () => {
    const store = createFlakyStore(0);
    const source = createSource(store);

    const first = await source.loadParquetTable(PARQUET_PATH);
    const second = await source.loadParquetTable(PARQUET_PATH);

    expect(first).toBe(second);
  });
});
