import { DataType, Precision, type Table, tableFromIPC, type Vector } from 'apache-arrow';
import { type BigIntLane, toNumberValues } from '../arrowNumbers.js';
import {
  accumulateFeatureCatalogFromTable,
  buildFeatureCatalogFromColumns,
  countFeatureCodesHistogram,
  featureCatalogFromCodeMap,
  featureCatalogNeedsParquetFallback,
  featureCodeMapFromCatalog,
  resolveRowFeatureCodesFromTable,
} from '../pointsFeatures.js';
import type { PointsFeatureCatalog } from '../pointsTiling.js';
import {
  featureCodeAllowSet,
  isMortonSentinelValue,
  rowMatchesFeatureCode,
} from '../pointsTiling.js';

type ParquetWasmTableLike = { intoIPCStream(): Uint8Array };
type ParquetModule = {
  readParquet: (bytes: Uint8Array, options?: { columns?: string[] }) => ParquetWasmTableLike;
};

export type ParquetRowGroupBytesChunk = {
  schemaBytes: Uint8Array;
  rowGroupBytes: Uint8Array;
  rowGroupIndex: number;
  globalRowGroupIndex?: number;
};

type ReadParquetRowGroup = (
  schemaBytes: Uint8Array,
  rowGroupBytes: Uint8Array,
  rowGroupIndex: number,
  options?: { columns?: string[] }
) => ParquetWasmTableLike;

export async function decodeParquetPartsToTable(
  readParquet: ParquetModule['readParquet'],
  parts: Uint8Array[],
  columns: string[] | undefined,
  maxRows?: number
): Promise<Table> {
  const tables: Table[] = [];
  let accumulated = 0;
  for (const part of parts) {
    const table = tableFromIPC(readParquet(part, { columns }).intoIPCStream());
    if (maxRows === undefined) {
      tables.push(table);
      continue;
    }
    const remaining = maxRows - accumulated;
    if (table.numRows <= remaining) {
      tables.push(table);
      accumulated += table.numRows;
    } else {
      tables.push(table.slice(0, remaining));
      break;
    }
    if (accumulated >= maxRows) {
      break;
    }
  }
  if (tables.length === 0) {
    throw new Error('No parquet tables to decode');
  }
  return tables.slice(1).reduce((merged, part) => merged.concat(part), tables[0]);
}

export async function decodeParquetRowGroupsToTable(
  readParquetRowGroup: ReadParquetRowGroup,
  chunks: ParquetRowGroupBytesChunk[],
  columns: string[] | undefined,
  maxRows?: number
): Promise<Table> {
  const readOptions = columns?.length ? { columns } : undefined;
  const tables: Table[] = [];
  let accumulated = 0;
  for (const chunk of chunks) {
    const table = tableFromIPC(
      readParquetRowGroup(
        chunk.schemaBytes,
        chunk.rowGroupBytes,
        chunk.rowGroupIndex,
        readOptions
      ).intoIPCStream()
    );
    if (maxRows === undefined) {
      tables.push(table);
      continue;
    }
    const remaining = maxRows - accumulated;
    if (table.numRows <= remaining) {
      tables.push(table);
      accumulated += table.numRows;
    } else {
      tables.push(table.slice(0, remaining));
      break;
    }
    if (accumulated >= maxRows) {
      break;
    }
  }
  if (tables.length === 0) {
    throw new Error('No parquet row groups to decode');
  }
  return tables.slice(1).reduce((merged, part) => merged.concat(part), tables[0]);
}

export type ParquetWorkerPayloadInput = {
  parts?: Uint8Array[];
  rowGroups?: ParquetRowGroupBytesChunk[];
};

export async function decodeParquetPayloadToTable(
  readParquet: ParquetModule['readParquet'],
  readParquetRowGroup: ReadParquetRowGroup | undefined,
  payload: ParquetWorkerPayloadInput,
  columns: string[] | undefined,
  maxRows?: number
): Promise<Table> {
  if (payload.rowGroups?.length) {
    if (!readParquetRowGroup) {
      throw new Error('readParquetRowGroup is unavailable');
    }
    return decodeParquetRowGroupsToTable(readParquetRowGroup, payload.rowGroups, columns, maxRows);
  }
  if (payload.parts?.length) {
    return decodeParquetPartsToTable(readParquet, payload.parts, columns, maxRows);
  }
  throw new Error('No parquet parts or row groups to decode');
}

export function extractGeometryColumnar(
  table: Table,
  axisNames: string[]
): { shape: number[]; xs: Float32Array; ys: Float32Array; zs?: Float32Array } {
  const xColumn = table.getChild(axisNames[0]);
  const yColumn = table.getChild(axisNames[1]);
  if (!xColumn || !yColumn) {
    throw new Error(`Geometry columns not found in parquet table`);
  }
  // Nulls are not preserved on this path. `toArray()` returns arrow's data buffer
  // without its validity bitmap, so a null coordinate reads as whatever the writer
  // left there — `0` in practice — and renders at the origin. `numericColumnValues`,
  // which the tiled scan uses, boxes a nullable column instead and writes NaN, so the
  // SAME column is a point at (0, 0) here and a dropped row there. True of every
  // numeric type, not only the widened ones, and true of the two main-thread
  // fallbacks in `VPointsSource` that read columns the same way.
  const xs = Float32Array.from(toNumberValues(xColumn.toArray()));
  const ys = Float32Array.from(toNumberValues(yColumn.toArray()));
  const hasZ = axisNames.includes('z');
  const zColumn = hasZ ? table.getChild('z') : null;
  const zs = zColumn ? Float32Array.from(toNumberValues(zColumn.toArray())) : undefined;
  const shape = zs ? [3, xs.length] : [2, xs.length];
  return { shape, xs, ys, ...(zs ? { zs } : {}) };
}

export type DecodeGeometryWithFeaturesInput = ParquetWorkerPayloadInput & {
  axisNames: string[];
  /** Projected columns to decode: axes + feature key (+ code column if present). */
  columns: string[];
  featureKey: string;
  featureCodeColumnName?: string;
  maxRows?: number;
};

export type DecodeGeometryWithFeaturesResult = {
  shape: number[];
  data: Float32Array[];
  featureCodes?: Int32Array;
  featureCatalog?: PointsFeatureCatalog;
};

/**
 * One projected decode → geometry + per-row feature codes + feature catalog.
 *
 * This is the off-thread half of the codes-with-geometry preload: the caller
 * fetches whole row-group (or part) bytes via async range reads and hands them
 * here (in the worker) so the CPU-heavy parquet decode never touches the main
 * thread. The *bytes* are whole row groups (all columns) — parquet-wasm cannot fetch
 * individual column chunks — and `{ columns }` is inert in the vendored build, so the
 * decode is the full column set too (see docs/parquet-wasm-limitations.md). Mirrors
 * the main-thread derivation in
 * `VPointsSource.loadPoints` so both paths produce identical codes + catalog.
 */
export async function decodeGeometryWithFeaturesFromPayload(
  readParquet: ParquetModule['readParquet'],
  readParquetRowGroup: ReadParquetRowGroup | undefined,
  input: DecodeGeometryWithFeaturesInput
): Promise<DecodeGeometryWithFeaturesResult> {
  const table = await decodeParquetPayloadToTable(
    readParquet,
    readParquetRowGroup,
    { rowGroups: input.rowGroups, parts: input.parts },
    input.columns,
    input.maxRows
  );

  const geometry = extractGeometryColumnar(table, input.axisNames);
  const data = geometry.zs ? [geometry.xs, geometry.ys, geometry.zs] : [geometry.xs, geometry.ys];

  let featureCodes: Int32Array | undefined;
  let featureCatalog: PointsFeatureCatalog | undefined;
  const nameColumn = table.getChild(input.featureKey);
  if (nameColumn) {
    const codeColumn = input.featureCodeColumnName
      ? table.getChild(input.featureCodeColumnName)
      : null;
    featureCatalog = buildFeatureCatalogFromColumns(
      input.featureKey,
      nameColumn,
      codeColumn ?? null,
      null,
      table.numRows
    );
    const featureCodeByName = input.featureCodeColumnName
      ? undefined
      : featureCodeMapFromCatalog(featureCatalog);
    const codes = resolveRowFeatureCodesFromTable(
      table,
      input.featureKey,
      input.featureCodeColumnName,
      featureCodeByName
    );
    if (codes) {
      featureCodes = codes instanceof Int32Array ? codes : Int32Array.from(codes);
    }
  }

  return {
    shape: geometry.shape,
    data,
    ...(featureCodes ? { featureCodes } : {}),
    ...(featureCatalog ? { featureCatalog } : {}),
  };
}

export async function scanFeatureCatalogFromPayload(
  readParquet: ParquetModule['readParquet'],
  readParquetRowGroup: ReadParquetRowGroup | undefined,
  input: {
    rowGroups?: ParquetRowGroupBytesChunk[];
    parts: Uint8Array[];
    columns: string[];
    featureKey: string;
    featureCodeColumnName?: string;
    skipMortonSentinels?: boolean;
  }
): Promise<PointsFeatureCatalog | null> {
  const codeToName = new Map<number, string>();
  const nameToCode = new Map<string, number>();
  const catalogOptions = { skipMortonSentinels: input.skipMortonSentinels === true };

  if (input.featureCodeColumnName && input.rowGroups?.length && readParquetRowGroup) {
    const readOptions = { columns: input.columns };
    for (const chunk of input.rowGroups) {
      const table = tableFromIPC(
        readParquetRowGroup(
          chunk.schemaBytes,
          chunk.rowGroupBytes,
          chunk.rowGroupIndex,
          readOptions
        ).intoIPCStream()
      );
      if (table.numRows === 0) {
        continue;
      }
      accumulateFeatureCatalogFromTable(
        codeToName,
        nameToCode,
        table,
        input.featureKey,
        input.featureCodeColumnName,
        catalogOptions
      );
    }
  }

  if (featureCatalogNeedsParquetFallback(codeToName)) {
    codeToName.clear();
    nameToCode.clear();
    const table = await decodeParquetPartsToTable(readParquet, input.parts, input.columns);
    accumulateFeatureCatalogFromTable(
      codeToName,
      nameToCode,
      table,
      input.featureKey,
      input.featureCodeColumnName,
      catalogOptions
    );
  }

  if (codeToName.size === 0) {
    return null;
  }
  return featureCatalogFromCodeMap(input.featureKey, codeToName);
}

/**
 * Typed, growable output for the scans' matched coordinates.
 *
 * The scans used to accumulate into `number[]` and copy into a typed array at the
 * end. That pays three times: every value is boxed as a double (8 bytes plus V8
 * overhead against 4), the array reallocates as it grows, and the final
 * `Float32Array.from` copies the lot again — with both representations live at the
 * peak. Measured over 3 arrays:
 *
 *              646k rows        4M rows
 *   number[]      19ms            116ms
 *   growable       7ms             76ms   (doubling copies dominate at 4M)
 *   exact-sized    6ms             17ms
 *
 * So the capacity hint, not the typed storage, is what carries the win at scale.
 * Callers therefore {@link reserve} an exact upper bound before each chunk's loop —
 * `min(rows in this chunk, remaining cap)` — which is known for free once the chunk
 * is decoded, so pushes never reallocate. Growth is still handled, because a wrong
 * or absent hint must stay correct rather than corrupt the output.
 */
class TypedPointBuffer<T extends Float32Array | Float64Array | Int32Array> {
  private buffer: T;
  private count = 0;

  constructor(
    private readonly make: (length: number) => T,
    initialCapacity = 0
  ) {
    this.buffer = make(Math.max(initialCapacity, 0));
  }

  get length(): number {
    return this.count;
  }

  /** Ensure room for `additional` more values without reallocating. */
  reserve(additional: number): void {
    const needed = this.count + Math.max(additional, 0);
    if (needed <= this.buffer.length) {
      return;
    }
    this.grow(needed);
  }

  push(value: number): void {
    if (this.count === this.buffer.length) {
      // No hint, or the hint was low: double (never from 0, which never grows).
      this.grow(Math.max(this.buffer.length * 2, 1024));
    }
    this.buffer[this.count] = value;
    this.count += 1;
  }

  private grow(capacity: number): void {
    const next = this.make(capacity);
    next.set(this.buffer.subarray(0, this.count) as never);
    this.buffer = next;
  }

  /**
   * The filled prefix, exactly sized. Zero-copy when the reservation was exact —
   * the normal case — and otherwise one copy, which is what the old
   * `Float32Array.from` cost anyway, so this is never worse.
   */
  toArray(): T {
    return (
      this.count === this.buffer.length ? this.buffer : this.buffer.slice(0, this.count)
    ) as T;
  }
}

export class Float32PointBuffer extends TypedPointBuffer<Float32Array> {
  constructor(initialCapacity = 0) {
    super((length) => new Float32Array(length), initialCapacity);
  }
}

export class Float64PointBuffer extends TypedPointBuffer<Float64Array> {
  constructor(initialCapacity = 0) {
    super((length) => new Float64Array(length), initialCapacity);
  }
}

export class Int32PointBuffer extends TypedPointBuffer<Int32Array> {
  constructor(initialCapacity = 0) {
    super((length) => new Int32Array(length), initialCapacity);
  }
}

/**
 * A numeric Arrow column as ONE indexable typed array.
 *
 * `Vector.get(i)` looks like an array read but is not. On a multi-chunk vector —
 * which is every table assembled from more than one record batch — Arrow swaps in
 * a prototype whose `get` is `binarySearch(data, offsets, i)`, so each read walks
 * the chunk offsets. Even the single-chunk fast path is a closure dispatch
 * returning a boxed value. Measured over 4M rows, per column:
 *
 *     .get() per row     1 chunk  49ms | 8 chunks 148ms | 64 chunks 244ms
 *     toArray() + index  1 chunk   6ms | 8 chunks  17ms | 64 chunks   5ms
 *
 * and the scan loops pay that for x, y and z, over every SCANNED row (the whole
 * dataset), not just the matched ones. `toArray()` costs 0–2ms — it is zero-copy
 * for a single chunk and one sequential concat otherwise — so hoisting it out of
 * the loop is 15–50x on the hot path for a one-line change at each call site.
 *
 * A nullable column is materialised through `get()` once, with nulls as NaN, so
 * callers keep a single indexed loop shape rather than a second slow path. Note
 * that this makes a non-finite coordinate skipped rather than emitted, which the
 * old `typeof x !== 'number'` test let through — a point at NaN cannot render.
 */
function numericColumnValues(column: Vector | null | undefined): ArrayLike<number> | null {
  if (!column) {
    return null;
  }
  if (column.nullCount === 0) {
    // `Vector.toArray()` is typed `any`, so this annotation is where arrow's actual
    // contract gets stated: a typed lane for a primitive column, a plain array
    // otherwise. Ruling out the plain array is what leaves a lane `toNumberValues`
    // can take, and it is the same test as the `ArrayBuffer.isView` it replaces —
    // only the typed lanes can be handed back without boxing.
    const values: ArrayLike<number> | BigIntLane | unknown[] = column.toArray();
    if (!Array.isArray(values)) {
      return toNumberValues(values);
    }
  }
  const out = new Float64Array(column.length);
  for (let index = 0; index < column.length; index += 1) {
    const value = column.get(index);
    // `bigint` for the same reason the fast path above converts: a NULLABLE int64
    // column takes this branch instead, and reading it as "not a number" would turn
    // every coordinate into NaN rather than throwing — the silent version of the
    // same bug. A 64-bit *identifier* never reaches here; `resolvePassthroughColumns`
    // refuses one on its type before the column is read at all.
    if (typeof value === 'bigint') {
      out[index] = Number(value);
      continue;
    }
    out[index] = typeof value === 'number' ? value : Number.NaN;
  }
  return out;
}

/**
 * A numeric column carried through the tiled scan alongside the geometry.
 *
 * These cost nothing on the wire, and nothing to decode — a property of the reader THIS
 * path uses, not of parquet-wasm. `readParquetRowGroup` takes the contiguous bytes of a
 * whole row group, and `{ columns }` is inert in the vendored build
 * (`docs/parquet-wasm-limitations.md`), so the tiled path already range-reads AND
 * decodes every column of every row group it touches, then discards most of them —
 * `qv`, `nucleus_distance` and `overlaps_nucleus` are paid for on every tile whether or
 * not anyone asks for them. Asking adds one buffer and one transfer. `ParquetFile.read`
 * is the reader that WOULD project — so an extra column costs bytes again if this path
 * ever moves there, but not before published parquet-wasm 0.8.0, where a projected read
 * first becomes parseable.
 *
 * Float, bool and integers up to 32 bits, all of which a `Float64Array` carries
 * exactly. A 64-bit identifier does not, so {@link resolvePassthroughColumns} refuses
 * one rather than returning it quietly rounded. String columns (`cell_id`) want codes
 * plus a catalog, the shape `featureCodes` already uses, and are not served here.
 */
export interface PassthroughColumn {
  name: string;
  /**
   * Accumulates across row groups. Deliberately the ONLY state carried between
   * tables: the values are re-read from each table as it is scanned, because a tile
   * spanning two row groups would otherwise pair the second group's points with the
   * first group's values — one value per point, so no length check could catch it.
   */
  buffer: Float64PointBuffer;
}

/** Why a requested passthrough column could not be served. */
export interface PassthroughColumnRejection {
  name: string;
  reason: 'missing' | 'not-numeric' | 'precision' | 'after-dictionary';
}

/**
 * What to tell the caller about a rejection, beyond its tag.
 *
 * "unsupported type" would read as a shrug. Every reason here is a case where the column
 * could have come back at the right length, in lockstep with the geometry, and WRONG —
 * which is the only thing that makes refusing it worth a warning.
 */
export const PASSTHROUGH_REJECTION_EXPLANATIONS: Record<
  PassthroughColumnRejection['reason'],
  string
> = {
  missing: 'not present in the row group',
  'not-numeric': 'not a numeric type — a string column decodes to a full-length NaN array',
  precision: 'an integer wider than 32 bits — the f64 lane would round it silently',
  'after-dictionary':
    'at or after a dictionary-typed column, which this reader mis-decodes — its values ' +
    'would be wrong rather than missing',
};

export interface ResolvedPassthroughColumns {
  columns: PassthroughColumn[];
  rejected: PassthroughColumnRejection[];
}

/**
 * Values for one passthrough column, read from the table about to be scanned.
 *
 * Two arrow types need decoding rather than the fast `toArray()` path that
 * `numericColumnValues` takes, and both fail quietly if they do not get it:
 *
 * * **Bool** — that helper's boxed path keeps only `typeof value === 'number'`, so a
 *   Bool column comes back as a full-length array of `NaN`.
 * * **Float16** — arrow stores it as `Uint16Array`, which IS an `ArrayBuffer` view, so
 *   the null-free fast path returns the raw **bit patterns**: Float16 `1` arrives as
 *   `15360`. `get()` converts properly. A nullable Float16 fixture would not catch
 *   this, because nulls force the boxed path that is already correct.
 *
 * Both are the same failure the string guard exists for — right length, right
 * alignment, wrong numbers.
 */
function decodeBoxed(column: Vector, convert: (value: unknown) => number): Float64Array {
  const out = new Float64Array(column.length);
  for (let index = 0; index < column.length; index += 1) {
    const value = column.get(index);
    out[index] = value === null || value === undefined ? Number.NaN : convert(value);
  }
  return out;
}

function passthroughValues(column: Vector): ArrayLike<number> | null {
  const type = column.type;
  if (DataType.isBool(type)) {
    return decodeBoxed(column, (value) => (value ? 1 : 0));
  }
  if (DataType.isFloat(type) && type.precision === Precision.HALF) {
    return decodeBoxed(column, (value) => Number(value));
  }
  return numericColumnValues(column);
}

/** Columns the scan supplies itself; requesting one again would duplicate it. */
function isReservedScanColumn(
  name: string,
  input: { axisNames: string[]; mortonCodeColumnName: string; featureCodeColumnName?: string }
): boolean {
  return (
    name === 'x' ||
    name === 'y' ||
    name === 'z' ||
    input.axisNames.includes(name) ||
    name === input.mortonCodeColumnName ||
    name === input.featureCodeColumnName
  );
}

/**
 * The index of the first dictionary-typed field, or -1 if the schema has none.
 *
 * A tripwire for the `readParquetRowGroup` path specifically. That reader silently
 * mis-decodes every field at or AFTER the first dictionary-typed one, not just the
 * dictionary column itself. Measured on row group 3 of the 12.17M-row
 * `transcripts_morton` element: `x` … `morton_code_2d` (fields 0–9) decode correctly,
 * then `feature_name` comes back `null`, `cell_id` and `fov_name` `""`, and
 * `__index_level_0__` `-1` — with `nullCount === 0` throughout and nothing thrown.
 * Verified against `pyarrow.read_row_group`, which returns the real values.
 *
 * It is not a string-only fault: a `Float32` column written after a pandas categorical
 * decodes as `NaN` (and an `Int32` as `-1`), from a `toArray()` 31 elements long against
 * a `length` of 1000. So a schema check is the only safe one — the values look like data.
 *
 * The SCHEMA survives intact, which is what makes a field-index comparison sufficient.
 *
 * Nothing served today is refused by this: `overlaps_nucleus` (3), `qv` (6) and
 * `nucleus_distance` (7) all precede `feature_name` (10). It guards the column order we
 * do not control — `cell_id` is the next column this work wants, and it sits on the far
 * side of the boundary. Drop the guard if the tiled path moves to `ParquetFile`, whose
 * reads decode dictionaries correctly (`parquetWasmLoader.ts`).
 */
function firstDictionaryFieldIndex(table: Table): number {
  return table.schema.fields.findIndex((field) => DataType.isDictionary(field.type));
}

/**
 * Decide which requested columns the scan can serve, from the arrow SCHEMA.
 *
 * Never from the decoded values: `numericColumnValues` answers a boxed read of a string
 * column with `Number.NaN` rather than null, so trusting it would hand back a `cell_id`
 * column of the right length, in lockstep, and entirely meaningless.
 *
 * Accepts float, bool, and integers up to 32 bits — every one of which a `Float64Array`
 * represents exactly. A 64-bit integer does not, so it is refused rather than returned
 * quietly rounded; a string column wants codes plus a catalog, the shape `featureCodes`
 * already uses, and is not served here.
 */
export function resolvePassthroughColumns(
  table: Table,
  requested: readonly string[] | undefined,
  context: { axisNames: string[]; mortonCodeColumnName: string; featureCodeColumnName?: string }
): ResolvedPassthroughColumns {
  const columns: PassthroughColumn[] = [];
  const rejected: PassthroughColumnRejection[] = [];
  const dictionaryBoundary = firstDictionaryFieldIndex(table);
  for (const name of requested ?? []) {
    if (isReservedScanColumn(name, context)) {
      continue;
    }
    const column = table.getChild(name);
    if (!column) {
      rejected.push({ name, reason: 'missing' });
      continue;
    }
    // Before the type checks: this is the reason that would still apply if the type
    // were fine, and the one that explains why a perfectly ordinary `qv` is refused.
    if (
      dictionaryBoundary >= 0 &&
      table.schema.fields.findIndex((field) => field.name === name) >= dictionaryBoundary
    ) {
      rejected.push({ name, reason: 'after-dictionary' });
      continue;
    }
    const type = column.type;
    if (DataType.isInt(type)) {
      // `bitWidth` is on the Int type; anything wider than 32 bits cannot survive the
      // f64 lane exactly, so refuse it rather than round `transcript_id`.
      if (type.bitWidth > 32) {
        rejected.push({ name, reason: 'precision' });
        continue;
      }
    } else if (!DataType.isFloat(type) && !DataType.isBool(type)) {
      rejected.push({ name, reason: 'not-numeric' });
      continue;
    }
    // Schema only. Calling `passthroughValues` here to prove the column decodes would
    // materialise every value of every requested column at resolve time, and the scan
    // decodes it again per row group anyway — the checks above are the decision, and
    // `scanMortonTableInBounds` drops a column that cannot be read when it gets there.
    columns.push({ name, buffer: new Float64PointBuffer() });
  }
  return { columns, rejected };
}

const EMPTY_PASSTHROUGH: readonly PassthroughColumn[] = [];

export function scanMortonTableInBounds(input: {
  table: Table;
  rowGroupIndex: number;
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  axisNames: string[];
  mortonCodeColumnName: string;
  featureCodeColumnName?: string;
  featureCodes?: readonly number[];
  xs: Float32PointBuffer;
  ys: Float32PointBuffer;
  zs: Float32PointBuffer;
  /**
   * Per-point feature codes for the matched rows. Optional, but supplying it is what
   * lets a tiled layer colour by feature at all. Lockstep is the whole contract — index
   * i names the feature of point i in {@link xs}/{@link ys} — so every `continue` above
   * a push must skip all four buffers together.
   */
  codes?: Int32PointBuffer;
  /**
   * Extra numeric columns to carry through, in lockstep with the geometry. Same
   * contract as {@link codes}: index i belongs to point i, so every `continue`
   * above a push must skip these too. Build them with
   * {@link resolvePassthroughColumns} so the reserved and unrepresentable names
   * are filtered out before they get here.
   */
  passthrough?: readonly PassthroughColumn[];
}): void {
  const allowedFeatureCodes = featureCodeAllowSet(input.featureCodes);
  const filterByFeature = allowedFeatureCodes !== null;
  const hasZ = input.axisNames.includes('z');
  const xColumn = input.table.getChild('x');
  const yColumn = input.table.getChild('y');
  const zColumn = hasZ ? input.table.getChild('z') : null;
  const mortonColumn = input.table.getChild(input.mortonCodeColumnName);
  const featureCodeColumn = input.featureCodeColumnName
    ? input.table.getChild(input.featureCodeColumnName)
    : null;
  if (!xColumn || !yColumn) {
    return;
  }
  // Hoisted out of the loop: see `numericColumnValues`. The feature-code column
  // matters most here — it is read for EVERY row, before any bounds rejection.
  const xValues = numericColumnValues(xColumn);
  const yValues = numericColumnValues(yColumn);
  const zValues = numericColumnValues(zColumn);
  const featureCodeValues = numericColumnValues(featureCodeColumn);
  if (!xValues || !yValues) {
    return;
  }
  // A filter this scan cannot honour must match NOTHING, not everything. The
  // predicate below used to carry the column check as a conjunct, so a missing
  // code column made it false for every row and the caller got the whole chunk
  // back — one gene requested, 4M points drawn, and no error anywhere. An empty
  // result is also wrong, but it is wrong visibly.
  if (filterByFeature && !featureCodeValues) {
    return;
  }
  // Not collecting is fine — the render falls back to a flat colour — but a SHORT array
  // would be worse than none: misaligned against the geometry, confidently mis-colouring
  // every point after the first gap.
  const collectCodes = input.codes !== undefined && featureCodeValues !== null;
  // Hoisted: `Table.numRows` is not a field but
  // `data.reduce((n, d) => n + d.length, 0)` — a closure allocation and a walk of
  // every chunk. As a loop CONDITION that ran per row. See `scanTableByFeatureCodes`.
  const numRows = input.table.numRows;
  // Upper bound: at most one match per row. Bounds-rejection usually leaves this
  // over-reserved, but only transiently, and it removes the growth copies.
  input.xs.reserve(numRows);
  input.ys.reserve(numRows);
  if (zValues) {
    input.zs.reserve(numRows);
  }
  if (input.codes) {
    input.codes.reserve(numRows);
  }
  // Bound to THIS table, every call. The columns were resolved once (by name, against
  // the file's schema, which every row group shares) but their values must come from
  // the row group being scanned — `rowIndex` restarts at zero for each one.
  const passthrough: Array<{ values: ArrayLike<number>; buffer: Float64PointBuffer }> = [];
  for (const extra of input.passthrough ?? EMPTY_PASSTHROUGH) {
    const column = input.table.getChild(extra.name);
    const values = column ? passthroughValues(column) : null;
    if (!values) {
      // Present when resolved, absent now: scanning on would silently shorten this
      // column against the geometry. Drop it here and the caller's length check drops
      // it from the result.
      continue;
    }
    extra.buffer.reserve(numRows);
    passthrough.push({ values, buffer: extra.buffer });
  }
  for (let rowIndex = 0; rowIndex < numRows; rowIndex += 1) {
    // Sentinels only ever occupy the first rows of the first row group, so this
    // stays on the (rare) boxed read rather than materialising the whole column.
    if (
      input.rowGroupIndex === 0 &&
      rowIndex < 4 &&
      isMortonSentinelValue(mortonColumn?.get(rowIndex))
    ) {
      continue;
    }
    if (
      filterByFeature &&
      !rowMatchesFeatureCode(
        (featureCodeValues as ArrayLike<number>)[rowIndex],
        allowedFeatureCodes
      )
    ) {
      continue;
    }
    const x = xValues[rowIndex];
    const y = yValues[rowIndex];
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      continue;
    }
    if (
      x < input.bounds.minX ||
      x > input.bounds.maxX ||
      y < input.bounds.minY ||
      y > input.bounds.maxY
    ) {
      continue;
    }
    input.xs.push(x);
    input.ys.push(y);
    if (zValues) {
      const z = zValues[rowIndex];
      input.zs.push(Number.isFinite(z) ? z : 0);
    }
    for (const extra of passthrough) {
      // NaN is kept rather than coerced: unlike a feature code, a missing `qv` or
      // `nucleus_distance` has no in-band sentinel, and 0 is a plausible reading.
      extra.buffer.push(extra.values[rowIndex]);
    }
    if (collectCodes) {
      const code = (featureCodeValues as ArrayLike<number>)[rowIndex];
      // A non-finite code is a real row with an unknown feature: keep the point and
      // record -1, the shader's existing "no feature" sentinel. Dropping it would put a
      // hole in the geometry to express a gap in the colour.
      (input.codes as Int32PointBuffer).push(Number.isFinite(code) ? code : -1);
    }
  }
}

/**
 * Assign a code to each row of one feature-column batch, appending into `codeBuffer`
 * at `offset` and tallying into `codeCounts`.
 *
 * Codes are allocated on first sight via the shared `nameToCode`, so they stay
 * stable for the whole stream — a gene coloured in batch 1 keeps its code in batch
 * 62, and `codeToName` always describes the codes actually written. For a
 * dictionary chunk that means dictionary order, not row order; the caller documents
 * why that is fine.
 *
 * Lives here rather than beside its main-thread caller because the worker's
 * `streamGeometryWithFeatures` handler needs the identical accumulation — the two
 * paths must assign the same codes for the same stream or the catalog they publish
 * would not describe the codes they wrote.
 *
 * A DICTIONARY column resolves its values once per chunk and maps raw indices;
 * asking the vector per row would materialise a JS string per point (~59s for 4M
 * rows) instead of once per distinct feature. See `resolveRowFeatureCodesFromTable`.
 */
export function appendFeatureCodesFromColumn(
  column: Vector,
  rows: number,
  codeToName: Map<number, string>,
  nameToCode: Map<string, number>,
  codeBuffer: Int32Array,
  codeCounts: Map<number, number>,
  offset: number
): void {
  const codeFor = (name: string): number => {
    let code = nameToCode.get(name);
    if (code === undefined) {
      code = nameToCode.size;
      nameToCode.set(name, code);
      codeToName.set(code, name);
    }
    return code;
  };
  let written = 0;
  let chunkStart = 0;
  for (const chunk of column.data) {
    if (written >= rows) {
      break;
    }
    const take = Math.min(chunk.length, rows - written);
    const dictionary = chunk.dictionary;
    if (dictionary && chunk.nullCount === 0) {
      const codeByIndex = new Int32Array(dictionary.length);
      for (let index = 0; index < dictionary.length; index += 1) {
        const name = dictionary.get(index);
        codeByIndex[index] = name == null ? -1 : codeFor(String(name));
      }
      const indices = chunk.values as ArrayLike<number>;
      for (let row = 0; row < take; row += 1) {
        const index = indices[row];
        const code = index >= 0 && index < codeByIndex.length ? codeByIndex[index] : -1;
        codeBuffer[offset + written + row] = code;
        codeCounts.set(code, (codeCounts.get(code) ?? 0) + 1);
      }
    } else {
      for (let row = 0; row < take; row += 1) {
        const value = column.get(chunkStart + row);
        const code = value == null ? -1 : codeFor(String(value));
        codeBuffer[offset + written + row] = code;
        codeCounts.set(code, (codeCounts.get(code) ?? 0) + 1);
      }
    }
    written += take;
    chunkStart += chunk.length;
  }
}

export function extractRowFeatureCodesFromTable(
  table: Table,
  featureKey: string,
  featureCodeColumnName?: string,
  featureCodeByName?: ReadonlyMap<string, number>
): Int32Array {
  const resolved = resolveRowFeatureCodesFromTable(
    table,
    featureKey,
    featureCodeColumnName,
    featureCodeByName
  );
  if (!resolved) {
    return new Int32Array(0);
  }
  if (resolved instanceof Int32Array) {
    return resolved;
  }
  return Int32Array.from(resolved);
}

export function histogramToSortedArrays(counts: Map<number, number>): {
  codes: Int32Array;
  countValues: Uint32Array;
} {
  const sorted = [...counts.entries()].sort((left, right) => left[0] - right[0]);
  return {
    codes: Int32Array.from(sorted.map(([code]) => code)),
    countValues: Uint32Array.from(sorted.map(([, count]) => count)),
  };
}

export function scanTableFeatureCounts(
  table: Table,
  featureKey: string,
  featureCodeColumnName: string | undefined,
  counts: Map<number, number>
): void {
  const rowCodes = extractRowFeatureCodesFromTable(table, featureKey, featureCodeColumnName);
  for (let index = 0; index < rowCodes.length; index += 1) {
    const code = rowCodes[index];
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
}

export function scanTableByFeatureCodes(input: {
  table: Table;
  axisNames: string[];
  featureKey: string;
  featureCodeColumnName?: string;
  featureCodes: readonly number[];
  memoryCap: number;
  matchedRows: number;
  xs: Float32PointBuffer;
  ys: Float32PointBuffer;
  zs: Float32PointBuffer;
  /** Optional per-matched-row feature codes, collected for colour-by-feature. */
  codes?: Int32PointBuffer;
  /** Authoritative name→code map for dict-only elements (no code column), so a
   * row's feature_name resolves to the same code space the selection uses. */
  featureCodeByName?: ReadonlyMap<string, number>;
}): number {
  const allowed = featureCodeAllowSet(input.featureCodes);
  if (allowed !== null && allowed.size === 0) {
    return input.matchedRows;
  }
  const rowCodes = extractRowFeatureCodesFromTable(
    input.table,
    input.featureKey,
    input.featureCodeColumnName,
    input.featureCodeByName
  );
  const xColumn = input.axisNames.includes('x') ? input.table.getChild('x') : null;
  const yColumn = input.axisNames.includes('y') ? input.table.getChild('y') : null;
  const zColumn = input.axisNames.includes('z') ? input.table.getChild('z') : null;
  // Hoisted out of the loop: see `numericColumnValues` — a per-row `Vector.get`
  // binary-searches the chunk offsets, and this loop runs over every scanned row.
  const xValues = numericColumnValues(xColumn);
  const yValues = numericColumnValues(yColumn);
  const zValues = numericColumnValues(zColumn);
  if (!xValues || !yValues) {
    return input.matchedRows;
  }
  let matchedRows = input.matchedRows;
  // Hoisted, and this is the one that dominated. `Table.numRows` is NOT a field:
  //
  //     get numRows() { return this.data.reduce((n, d) => n + d.length, 0); }
  //
  // — a fresh closure plus a walk of every chunk, on EVERY iteration, because it
  // sat in the loop condition. Measured over 4M rows: 35ms at 1 chunk, 112ms at 8,
  // 662ms at 64, against 4-7ms hoisted (7x / 30x / 97x). It grows with chunk count,
  // so it got worse exactly as the table got bigger — and it outweighed the whole
  // per-row `Vector.get` cost it was sitting next to.
  const numRows = input.table.numRows;
  // At most one match per scanned row, and never past the cap: an exact upper
  // bound, so the pushes below cannot reallocate. See `TypedPointBuffer`.
  const headroom = Math.min(numRows, Math.max(input.memoryCap - matchedRows, 0));
  input.xs.reserve(headroom);
  input.ys.reserve(headroom);
  if (zValues) {
    input.zs.reserve(headroom);
  }
  input.codes?.reserve(headroom);
  for (let rowIndex = 0; rowIndex < numRows; rowIndex += 1) {
    if (matchedRows >= input.memoryCap) {
      break;
    }
    if (allowed !== null && !rowMatchesFeatureCode(rowCodes[rowIndex], allowed)) {
      continue;
    }
    const x = xValues[rowIndex];
    const y = yValues[rowIndex];
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      continue;
    }
    input.xs.push(x);
    input.ys.push(y);
    if (zValues) {
      const z = zValues[rowIndex];
      input.zs.push(Number.isFinite(z) ? z : 0);
    }
    input.codes?.push(rowCodes[rowIndex] ?? -1);
    matchedRows += 1;
  }
  return matchedRows;
}

export function countFeatureCodesFromArray(sourceFeatureCodes: ArrayLike<number>): {
  codes: Int32Array;
  countValues: Uint32Array;
} {
  return histogramToSortedArrays(countFeatureCodesHistogram(sourceFeatureCodes));
}
