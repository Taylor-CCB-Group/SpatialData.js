import { featureCatalogFromCodeMap } from './pointsFeatures.js';
import type { PointsLoadResult } from './pointsLoadOptions.js';
import type { ParquetWorkerStreamChunk } from './workers/parquetWorkerProtocol.js';

export type PointsStreamAccumulatorOptions = {
  axisCount: number;
  /** Hard row cap; the buffers are allocated at this size up front. */
  maxRows: number;
  featureKey: string;
  totalRowCount: number;
  preloadTruncated: boolean;
  hasFeatureCodeColumn: boolean;
};

/**
 * The main-thread half of the worker's streaming points preload: it owns the
 * buffers, the worker owns the decode.
 *
 * The split is what keeps the UI thread free. Each batch arrives as a DELTA — its
 * own rows, plus only the catalog entries and per-feature tallies that batch was
 * the first to contribute — so appending is two typed-array copies and a walk over
 * however few distinct features the batch touched. No parquet decode, no dictionary
 * walk, no per-row string.
 *
 * Buffers are preallocated at the cap and appended at a cursor, so {@link snapshot}
 * hands out subarray VIEWS and emitting a progress tick stays O(1) — the same
 * arrangement the main-thread stream uses, and the reason a 60-batch preload does
 * not re-concatenate 4M rows sixty times.
 */
export class PointsStreamAccumulator {
  private readonly axisBuffers: Float32Array[];
  private readonly codeBuffer: Int32Array;
  private readonly codeToName = new Map<number, string>();
  private readonly codeCounts = new Map<number, number>();
  private filledRows = 0;
  /**
   * Memoised, and rebuilt only when a batch actually brought new features.
   *
   * A dictionary feature column names every feature within the first batch or two,
   * so the remaining ~60 ticks of a 4M-row element reuse this object. Rebuilding per
   * tick instead would re-materialise a 12k-entry catalog sixty times over — putting
   * a slice of the very cost this path exists to remove back on the main thread.
   */
  private catalog: PointsLoadResult['featureCatalog'];

  constructor(private readonly options: PointsStreamAccumulatorOptions) {
    this.axisBuffers = Array.from(
      { length: options.axisCount },
      () => new Float32Array(options.maxRows)
    );
    this.codeBuffer = new Int32Array(options.maxRows);
    this.catalog = featureCatalogFromCodeMap(options.featureKey, this.codeToName);
  }

  /** Rows appended so far. */
  get filled(): number {
    return this.filledRows;
  }

  /**
   * Append one streamed batch, clamped to the remaining cap.
   *
   * Returns the rows actually taken — 0 once full, which is the caller's cue that
   * a progress tick would report nothing new.
   */
  append(chunk: ParquetWorkerStreamChunk): number {
    const rows = Math.min(chunk.rows, this.options.maxRows - this.filledRows);
    if (rows <= 0) {
      return 0;
    }
    for (let axis = 0; axis < this.options.axisCount; axis += 1) {
      const values = chunk.axes[axis];
      if (!values) {
        // A part missing one of the element's axes. The main-thread stream leaves
        // the gap zeroed rather than failing the load; match it.
        continue;
      }
      this.axisBuffers[axis].set(
        values.length === rows ? values : values.subarray(0, rows),
        this.filledRows
      );
    }
    const codes = chunk.featureCodes;
    this.codeBuffer.set(codes.length === rows ? codes : codes.subarray(0, rows), this.filledRows);
    if (chunk.newFeatures.length > 0) {
      for (const entry of chunk.newFeatures) {
        this.codeToName.set(entry.code, entry.name);
      }
      this.catalog = featureCatalogFromCodeMap(this.options.featureKey, this.codeToName);
    }
    if (rows === chunk.rows) {
      for (let index = 0; index < chunk.tallyCodes.length; index += 1) {
        const code = chunk.tallyCodes[index];
        this.codeCounts.set(code, (this.codeCounts.get(code) ?? 0) + chunk.tallyCounts[index]);
      }
    } else {
      // The cap landed inside this batch, so its own tallies count rows being
      // dropped. Re-tally just the prefix that is kept — otherwise the per-feature
      // counts describe more points than the buffers hold.
      for (let row = 0; row < rows; row += 1) {
        const code = codes[row];
        this.codeCounts.set(code, (this.codeCounts.get(code) ?? 0) + 1);
      }
    }
    this.filledRows += rows;
    return rows;
  }

  /**
   * The preload as it stands: views over the filled prefix, plus the catalog that
   * describes the codes actually written.
   *
   * The codes and the catalog are consistent WITH EACH OTHER but are in this
   * stream's own code space, not the full-dataset scan's — the same contract the
   * main-thread stream publishes, which `remapRowFeatureCodes` reconciles once the
   * authoritative catalog settles.
   */
  snapshot(): PointsLoadResult {
    return {
      shape: [this.options.axisCount, this.filledRows] as [number, number],
      data: this.axisBuffers.map((buffer) => buffer.subarray(0, this.filledRows)),
      totalRowCount: this.options.totalRowCount,
      preloadTruncated: this.options.preloadTruncated,
      hasFeatureCodeColumn: this.options.hasFeatureCodeColumn,
      featureCodes: this.codeBuffer.subarray(0, this.filledRows),
      featureCatalog: this.catalog,
      featureCodeCounts: new Map(this.codeCounts),
    };
  }
}
