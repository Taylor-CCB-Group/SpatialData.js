import { describe, expect, it, vi } from 'vitest';
import SpatialDataPointsSource from '../src/models/VPointsSource.js';

/**
 * The feature scan prefers `ParquetFile.stream({ columns, rowGroups })`, whose
 * reader fetches per COLUMN CHUNK — the point being that the projection reaches
 * the network instead of pulling whole row groups (all 12 columns of a Xenium
 * `transcripts`) to use three.
 *
 * That reader needs a fetchable URL and a server that answers the range shapes it
 * expects, so it is a fast path and not a replacement. These pin the GATE: every
 * store the reader cannot serve has to fall through to the byte-oriented worker
 * path, because a wrong answer here does not fail loudly — it either fetches
 * nothing (a gene that renders no points) or silently keeps the slow path forever.
 */
function sourceWithStore(store: unknown) {
  return new SpatialDataPointsSource({ store, fileType: '.zarr' } as never);
}

type Internals = {
  canStreamMatchingScan: (
    path: string
  ) => Promise<{ urls: string[]; rowGroupCounts: number[] } | null>;
  canStreamParquetByUrl: () => Promise<boolean>;
  loadParquetDatasetMetadata: (path: string) => Promise<unknown>;
  resolveStoreUrl: (path: string) => string | null;
  serverSupportsStreamingRanges: (url: string) => Promise<boolean>;
};

const parquetPath = 'points/transcripts/points.parquet';
const twoParts = {
  parts: [{ path: `${parquetPath}/part.0.parquet` }, { path: `${parquetPath}/part.1.parquet` }],
  // Row-group counts ride along so the worker path can window its requests.
  numRowGroupsByPart: [3, 2],
};

function harness(over: Partial<Internals> = {}) {
  const source = sourceWithStore({ async get() {}, async getRange() {} });
  const internals = source as unknown as Internals;
  vi.spyOn(internals, 'canStreamParquetByUrl').mockResolvedValue(true);
  vi.spyOn(internals, 'loadParquetDatasetMetadata').mockResolvedValue(twoParts);
  vi.spyOn(internals, 'resolveStoreUrl').mockImplementation(
    (path: string) => `http://example.test/${path}`
  );
  vi.spyOn(internals, 'serverSupportsStreamingRanges').mockResolvedValue(true);
  for (const [key, value] of Object.entries(over)) {
    vi.spyOn(internals, key as keyof Internals).mockImplementation(value as never);
  }
  return internals;
}

describe('feature scan — streaming gate', () => {
  it('streams when every part resolves to a range-capable URL', async () => {
    const internals = harness();
    await expect(internals.canStreamMatchingScan(parquetPath)).resolves.toEqual({
      urls: [
        `http://example.test/${parquetPath}/part.0.parquet`,
        `http://example.test/${parquetPath}/part.1.parquet`,
      ],
      rowGroupCounts: [3, 2],
    });
  });

  it('declines when the reader is unavailable in this runtime', async () => {
    // `supportsParquetStreaming()` is false off the browser main thread — notably
    // inside the points worker, and in Node.
    const internals = harness({ canStreamParquetByUrl: async () => false });
    await expect(internals.canStreamMatchingScan(parquetPath)).resolves.toBeNull();
  });

  it('declines for a non-URL store, which the reader cannot fetch at all', async () => {
    const internals = harness({ resolveStoreUrl: () => null });
    await expect(internals.canStreamMatchingScan(parquetPath)).resolves.toBeNull();
  });

  it('declines when the server refuses the range shapes the reader needs', async () => {
    // A server that 416s suffix ranges makes the reader trap with an unsettleable
    // promise, so this must be decided BEFORE handing it a URL.
    const internals = harness({ serverSupportsStreamingRanges: async () => false });
    await expect(internals.canStreamMatchingScan(parquetPath)).resolves.toBeNull();
  });

  it('declines when even one part of a multipart element is unservable', async () => {
    // Mixed capability would otherwise scan some parts and silently skip others —
    // a partial gene rather than a failure.
    const internals = harness({
      serverSupportsStreamingRanges: async (url: string) => !url.endsWith('part.1.parquet'),
    });
    await expect(internals.canStreamMatchingScan(parquetPath)).resolves.toBeNull();
  });

  it('declines when the part layout cannot be resolved', async () => {
    const internals = harness({ loadParquetDatasetMetadata: async () => null });
    await expect(internals.canStreamMatchingScan(parquetPath)).resolves.toBeNull();
  });
});
