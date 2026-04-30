import { describe, expect, it, vi } from 'vitest';
import SpatialDataTableSource from '../src/models/VTableSource.js';

function createParquetBytes() {
  return new Uint8Array([0x50, 0x41, 0x52, 0x31, 0x00, 0x00, 0x00, 0x00, 0x50, 0x41, 0x52, 0x31]);
}

function createParquetTailBytes(footerLength: number) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setInt32(0, footerLength, true);
  bytes.set([0x50, 0x41, 0x52, 0x31], 4);
  return bytes;
}

function createParquetFooterBytes(footerLength: number) {
  const bytes = new Uint8Array(footerLength + 8);
  bytes.set([0x50, 0x41, 0x52, 0x31], footerLength + 4);
  return bytes;
}

describe('SpatialDataTableSource parquet fallbacks', () => {
  it('falls back to part.0.parquet when the direct parquet path returns an HTML listing', async () => {
    const parquetPath = 'points/cells/points.parquet';
    const htmlListingBytes = new TextEncoder().encode(
      '<!DOCTYPE html><html><body>folder listing</body></html>'
    );
    const multipartBytes = createParquetBytes();
    const get = vi.fn(async (path: string) => {
      if (path === `/${parquetPath}`) {
        return htmlListingBytes;
      }
      if (path === `/${parquetPath}/part.0.parquet`) {
        return multipartBytes;
      }
      return null;
    });

    const source = new SpatialDataTableSource({
      store: { get } as any,
      fileType: '.zarr',
    });

    await expect(source.loadParquetBytes(parquetPath)).resolves.toEqual(multipartBytes);
    await expect(source.loadParquetBytes(parquetPath)).resolves.toEqual(multipartBytes);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('falls back to part.0.parquet for schema reads when the direct parquet path returns HTML bytes', async () => {
    const parquetPath = 'points/cells/points.parquet';
    const footerLength = 12;
    const htmlListingBytes = new TextEncoder().encode(
      '<!DOCTYPE html><html><body>folder listing</body></html>'
    );
    const tailBytes = createParquetTailBytes(footerLength);
    const footerBytes = createParquetFooterBytes(footerLength);
    const getRange = vi.fn(async (path: string, { suffixLength }: { suffixLength: number }) => {
      if (path === `/${parquetPath}`) {
        return htmlListingBytes;
      }
      if (path === `/${parquetPath}/part.0.parquet` && suffixLength === 8) {
        return tailBytes;
      }
      if (path === `/${parquetPath}/part.0.parquet` && suffixLength === footerLength + 8) {
        return footerBytes;
      }
      return null;
    });

    const source = new SpatialDataTableSource({
      store: {
        get: vi.fn(),
        getRange,
      } as any,
      fileType: '.zarr',
    });

    await expect(source.loadParquetSchemaBytes(parquetPath)).resolves.toEqual(footerBytes);
    expect(getRange).toHaveBeenCalledTimes(3);
  });
});
