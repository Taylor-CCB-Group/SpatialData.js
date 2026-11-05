import type { ParquetBlobLike } from './parquetWasmLoader.js';

/**
 * The size a store-backed blob reports. parquet-wasm converts it to a 32-bit
 * signed integer somewhere on the open path and panics above this; the real
 * part may be anything up to it.
 */
export const STORE_BLOB_VIRTUAL_SIZE = 2 ** 31 - 1;

/** Reads `length` bytes at `offset` of one parquet part through its store. */
export type PartRangeReader = (
  offset: number,
  length: number
) => Promise<Uint8Array | null | undefined>;

/**
 * A `Blob` stand-in for `ParquetFile.fromFile`, so a store with `getRange` but
 * no URL (a zip, a picked folder) gets the same projected, batch-at-a-time
 * reader the URL path uses.
 *
 * The store cannot say how long the part is, so the blob claims
 * {@link STORE_BLOB_VIRTUAL_SIZE} and serves its last `footer.length` bytes
 * from the footer we already hold. The reader finds everything else by
 * absolute offset, which the store answers as-is. That holds while the real
 * part is no longer than the virtual size; `dataEnd` (the end of the last
 * column chunk) is checked against it, and a read that comes back short throws.
 *
 * Returns null when the part does not fit.
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
