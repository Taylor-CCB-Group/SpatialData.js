import { describe, expect, it, vi } from 'vitest';
import SpatialDataTableSource from '../src/models/VTableSource.js';

/**
 * `readParquetWorkerPayload` decides whether to download WHOLE PARTS — for a points
 * element that is the entire dataset, often 100MB+. These tests pin when it does,
 * because an unnecessary parts fetch is invisible in behaviour and only shows up as
 * a giant request in the network tab.
 */
type PayloadOptions = {
  maxRows: number;
  fullPartsForFallback?: boolean;
  includeRowGroups?: boolean;
  partsAlongsideRowGroups?: boolean;
};

function harness(options: { rowGroupCount: number; canUseRowGroups?: boolean }) {
  const source = new SpatialDataTableSource({
    fileType: '.zarr',
    store: {
      async get() {
        return undefined;
      },
    } as never,
  });
  const internals = source as unknown as {
    canLoadParquetRowGroups: () => Promise<boolean>;
    readParquetRowGroupsBytesCapped: (path: string, maxRows: number) => Promise<unknown[]>;
    readParquetDatasetBytesCapped: (
      path: string,
      maxRows: number
    ) => Promise<{ parts: Uint8Array[] }>;
    readParquetWorkerPayload: (
      path: string,
      options: PayloadOptions
    ) => Promise<{ rowGroups: unknown[]; parts: Uint8Array[] }>;
  };
  vi.spyOn(internals, 'canLoadParquetRowGroups').mockResolvedValue(
    options.canUseRowGroups !== false
  );
  vi.spyOn(internals, 'readParquetRowGroupsBytesCapped').mockResolvedValue(
    Array.from({ length: options.rowGroupCount }, (_value, index) => ({
      schemaBytes: new Uint8Array([1]),
      rowGroupBytes: new Uint8Array([2]),
      rowGroupIndex: index,
    }))
  );
  // Stands in for the whole-dataset download.
  const fetchParts = vi
    .spyOn(internals, 'readParquetDatasetBytesCapped')
    .mockResolvedValue({ parts: [new Uint8Array([9, 9, 9])] });
  return {
    fetchParts,
    run: (options2: PayloadOptions) =>
      internals.readParquetWorkerPayload('points/a/points.parquet', options2),
  };
}

describe('readParquetWorkerPayload — whole-part downloads', () => {
  it('does not download parts when row groups satisfy the caller', async () => {
    const { fetchParts, run } = harness({ rowGroupCount: 4 });

    const payload = await run({ maxRows: 1000, includeRowGroups: true });

    expect(payload.rowGroups).toHaveLength(4);
    expect(payload.parts).toEqual([]);
    expect(fetchParts).not.toHaveBeenCalled();
  });

  it('downloads parts alongside row groups only when explicitly asked', async () => {
    const { fetchParts, run } = harness({ rowGroupCount: 4 });

    // The catalog scan hands BOTH to the worker: a row-group decode of a
    // dictionary column can come back unusable, so parts are the fallback.
    const payload = await run({
      maxRows: Number.POSITIVE_INFINITY,
      includeRowGroups: true,
      partsAlongsideRowGroups: true,
      fullPartsForFallback: true,
    });

    expect(payload.rowGroups).toHaveLength(4);
    expect(payload.parts).toHaveLength(1);
    expect(fetchParts).toHaveBeenCalledOnce();
  });

  it('falls back to parts when no row groups were requested', async () => {
    const { fetchParts, run } = harness({ rowGroupCount: 0 });

    const payload = await run({ maxRows: 1000 });

    expect(payload.rowGroups).toEqual([]);
    expect(payload.parts).toHaveLength(1);
    expect(fetchParts).toHaveBeenCalledOnce();
  });

  it('falls back to parts when the store cannot do row-group reads', async () => {
    const { fetchParts, run } = harness({ rowGroupCount: 0, canUseRowGroups: false });

    const payload = await run({ maxRows: 1000, includeRowGroups: true });

    expect(payload.rowGroups).toEqual([]);
    expect(fetchParts).toHaveBeenCalledOnce();
  });
});
