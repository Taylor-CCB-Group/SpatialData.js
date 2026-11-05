import SpatialDataPointsSource from '../src/models/VPointsSource.js';
import type { ParquetWasmFile } from '../src/parquetWasmLoader.js';

interface RowGroupBytes {
  schemaBytes: Uint8Array;
  rowGroupBytes: Uint8Array;
  rowGroupIndex: number;
}

/**
 * A points source that widens the protected parquet-read seams to public, so a
 * spec can `vi.spyOn` them without casting. Behaviour is unchanged: each override
 * only forwards to `super`.
 */
export class ExposedPointsSource extends SpatialDataPointsSource {
  override resolveParquetRowCount(parquetPath: string): Promise<number> {
    return super.resolveParquetRowCount(parquetPath);
  }

  override readParquetRowGroupsBytesCapped(
    parquetPath: string,
    maxRows: number
  ): Promise<RowGroupBytes[]> {
    return super.readParquetRowGroupsBytesCapped(parquetPath, maxRows);
  }

  override readParquetWorkerPayload(
    parquetPath: string,
    options: {
      maxRows: number;
      fullPartsForFallback?: boolean;
      includeRowGroups?: boolean;
      partsAlongsideRowGroups?: boolean;
    }
  ): Promise<{ rowGroups: RowGroupBytes[]; parts: Uint8Array[] }> {
    return super.readParquetWorkerPayload(parquetPath, options);
  }

  override parquetPartFileOpeners(
    parquetPath: string
  ): Promise<Array<() => Promise<ParquetWasmFile>> | null> {
    return super.parquetPartFileOpeners(parquetPath);
  }
}
