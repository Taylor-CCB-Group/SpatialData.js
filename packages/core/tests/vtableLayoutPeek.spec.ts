import { describe, expect, it } from 'vitest';
import SpatialDataTableSource from '../src/models/VTableSource.js';

/**
 * Two hot paths PEEK at the resolved part layout to skip a known-useless probe
 * (the directory read that MDV answers with a 500). A peek is an optimisation,
 * so it must never be load-bearing.
 *
 * The cached layout promise can reject — `loadParquetDatasetMetadata` evicts on
 * rejection precisely because a failure is expected to be transient. Awaiting it
 * bare means that rejection escapes into the CALLER, and in `loadParquetBytes`
 * it escapes from the `for…of` header, so it bypasses the per-candidate
 * `try/catch` that exists to keep probing. One transient footer failure would
 * then turn a perfectly loadable single-file element into a hard error rather
 * than a fall back to the blind candidate order.
 */

const parquetPath = 'points/transcripts/points.parquet';

/** A parquet magic-number header, so `isParquetFileBytes` accepts the fixture. */
function parquetLikeBytes() {
  const bytes = new Uint8Array(16);
  bytes.set([0x50, 0x41, 0x52, 0x31], 0); // 'PAR1'
  bytes.set([0x50, 0x41, 0x52, 0x31], 12);
  return bytes;
}

type Internals = {
  parquetDatasetMetadataCache: Map<string, Promise<unknown>>;
};

function sourceWithRejectedLayout(paths: string[]) {
  const served = new Set(paths);
  const requested: string[] = [];
  const source = new SpatialDataTableSource({
    store: {
      async get(path: string) {
        requested.push(path);
        if (!served.has(path.replace(/^\//, ''))) {
          throw new Error(`404 ${path}`);
        }
        return parquetLikeBytes();
      },
    },
    fileType: '.zarr',
  } as never);

  const rejected = Promise.reject(new Error('transient footer read failure'));
  // The real cache entry evicts itself on rejection; attach the same handler so
  // this fixture does not trip Node's unhandled-rejection detector.
  rejected.catch(() => {});
  (source as unknown as Internals).parquetDatasetMetadataCache.set(parquetPath, rejected);

  return { source, requested };
}

describe('parquet layout peek — a rejected cached layout', () => {
  it('falls back to the blind candidate walk instead of failing the read', async () => {
    // The element is a plain single file, which the blind order finds on the
    // FIRST candidate — so a failure here can only come from the peek.
    const { source, requested } = sourceWithRejectedLayout([parquetPath]);

    const bytes = await source.loadParquetBytes(parquetPath);

    expect(bytes).not.toBeNull();
    expect(requested).toContain(`/${parquetPath}`);
  });

  it('still walks to a later candidate when the first is unservable', async () => {
    const { source } = sourceWithRejectedLayout([`${parquetPath}/part.0.parquet`]);

    const bytes = await source.loadParquetBytes(parquetPath);

    expect(bytes).not.toBeNull();
  });
});
