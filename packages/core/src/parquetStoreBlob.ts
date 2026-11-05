import type { ParquetBlobLike } from './parquetWasmLoader.js';

/** parquet-wasm panics on a blob size above i32 max. */
export const STORE_BLOB_VIRTUAL_SIZE = 2 ** 31 - 1;

export type PartRangeReader = (
  offset: number,
  length: number
) => Promise<Uint8Array | null | undefined>;

/**
 * A `Blob` stand-in for `ParquetFile.fromFile` over a store with no URL.
 *
 * The store can't report the part's length, so the blob claims `virtualSize`
 * and serves the cached footer at its end; every other read is by absolute
 * offset. Null if the part's data would overlap that footer.
 */
export function storeBackedParquetBlob(
  readRange: PartRangeReader,
  footer: Uint8Array,
  dataEnd: number,
  virtualSize: number = STORE_BLOB_VIRTUAL_SIZE
): ParquetBlobLike | null {
  const footerStart = virtualSize - footer.length;
  if (footerStart < 0 || dataEnd > footerStart) {
    return null;
  }

  const read = async (start: number, end: number): Promise<ArrayBuffer> => {
    const out = new Uint8Array(end - start);
    if (start < footerStart) {
      const storeEnd = Math.min(end, footerStart);
      const bytes = await readRange(start, storeEnd - start);
      if (!bytes || bytes.byteLength !== storeEnd - start) {
        throw new Error(
          `Store returned ${bytes?.byteLength ?? 'no'} bytes for a ${storeEnd - start}-byte ` +
            `parquet range at ${start}.`
        );
      }
      out.set(bytes, 0);
    }
    if (end > footerStart) {
      const from = Math.max(start, footerStart);
      out.set(footer.subarray(from - footerStart, end - footerStart), from - start);
    }
    return out.buffer;
  };

  const sliceOf = (start: number, end: number): ParquetBlobLike => ({
    size: end - start,
    slice: (relativeStart = 0, relativeEnd = end - start) =>
      sliceOf(
        start + Math.max(0, relativeStart),
        start + Math.min(Math.max(relativeEnd, relativeStart), end - start)
      ),
    arrayBuffer: () => read(start, end),
  });
  return sliceOf(0, virtualSize);
}
