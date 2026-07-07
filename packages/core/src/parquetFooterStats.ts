/**
 * Minimal parquet footer reader for per-row-group column statistics.
 *
 * The vendored parquet-wasm build exposes row-group + column-chunk metadata but
 * NOT `ColumnChunkMetaData.statistics()` (see docs/parquet-wasm-limitations.md),
 * so we cannot read a column's per-row-group min/max through it. Those values do
 * live in the parquet footer's Thrift-encoded `FileMetaData`, so this module
 * parses just enough of it (Thrift Compact Protocol) to recover, per row group,
 * each column's `path_in_schema`, physical `type`, and `Statistics` min/max.
 *
 * This powers the feature-primary index: for a feature-ordered points file, the
 * `feature_name_codes` min/max per row group lets us skip the row groups that
 * cannot contain the selected features, reading only the few that do.
 *
 * Scope: read-only, and deliberately partial — it extracts the fields we need and
 * skips everything else. Not a general Thrift/parquet implementation.
 */

// Thrift Compact Protocol type ids (field/element types).
const T_STOP = 0;
const T_BOOL_TRUE = 1;
const T_BOOL_FALSE = 2;
const T_BYTE = 3;
const T_I16 = 4;
const T_I32 = 5;
const T_I64 = 6;
const T_DOUBLE = 7;
const T_BINARY = 8;
const T_LIST = 9;
const T_SET = 10;
const T_MAP = 11;
const T_STRUCT = 12;

/** Parquet physical types (`Type` enum in parquet.thrift). */
export const ParquetPhysicalType = {
  BOOLEAN: 0,
  INT32: 1,
  INT64: 2,
  INT96: 3,
  FLOAT: 4,
  DOUBLE: 5,
  BYTE_ARRAY: 6,
  FIXED_LEN_BYTE_ARRAY: 7,
} as const;

export interface ParquetColumnStats {
  /** Dotted `path_in_schema`, e.g. "feature_name_codes". */
  path: string;
  /** Physical `Type` id, or null if absent. */
  physicalType: number | null;
  /** Raw `Statistics.min_value` (preferred) or deprecated `min`. */
  minValue?: Uint8Array;
  /** Raw `Statistics.max_value` (preferred) or deprecated `max`. */
  maxValue?: Uint8Array;
}

export interface ParquetRowGroupStats {
  numRows: number;
  columns: ParquetColumnStats[];
}

export interface ParquetFooterStats {
  numRows: number;
  rowGroups: ParquetRowGroupStats[];
}

class ThriftCompactReader {
  private pos = 0;
  constructor(private readonly buf: Uint8Array) {}

  atEnd(): boolean {
    return this.pos >= this.buf.length;
  }

  private byte(): number {
    if (this.pos >= this.buf.length) {
      throw new Error('parquet footer: unexpected end of buffer');
    }
    return this.buf[this.pos++];
  }

  /** Unsigned LEB128 varint as a JS number (values fit well under 2^53 here). */
  varint(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = this.byte();
      result += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) {
        return result;
      }
      shift += 7;
      if (shift > 63) {
        throw new Error('parquet footer: varint too long');
      }
    }
  }

  /** Zigzag-decoded signed varint. */
  zigzag(): number {
    const u = this.varint();
    return (u >>> 1) ^ -(u & 1);
  }

  /** Length-prefixed bytes (binary/string). */
  binary(): Uint8Array {
    const len = this.varint();
    const start = this.pos;
    this.pos += len;
    if (this.pos > this.buf.length) {
      throw new Error('parquet footer: binary overruns buffer');
    }
    return this.buf.subarray(start, start + len);
  }

  /**
   * Read a struct field header. Returns `{ type: T_STOP }` at the struct end.
   * `prevId` carries the compact-protocol field-id delta state within a struct.
   */
  fieldHeader(prevId: number): { type: number; id: number } {
    const b = this.byte();
    if (b === 0) {
      return { type: T_STOP, id: 0 };
    }
    const delta = (b & 0xf0) >> 4;
    const type = b & 0x0f;
    const id = delta === 0 ? this.zigzag() : prevId + delta;
    return { type, id };
  }

  /** Read a list/set header: `{ size, elemType }`. */
  listHeader(): { size: number; elemType: number } {
    const b = this.byte();
    const elemType = b & 0x0f;
    let size = (b & 0xf0) >> 4;
    if (size === 0x0f) {
      size = this.varint();
    }
    return { size, elemType };
  }

  /** Skip a value of the given compact type (for fields we don't care about). */
  skip(type: number): void {
    switch (type) {
      case T_BOOL_TRUE:
      case T_BOOL_FALSE:
        return;
      case T_BYTE:
        this.byte();
        return;
      case T_I16:
      case T_I32:
      case T_I64:
        this.varint();
        return;
      case T_DOUBLE:
        this.pos += 8;
        return;
      case T_BINARY:
        this.binary();
        return;
      case T_LIST:
      case T_SET: {
        const { size, elemType } = this.listHeader();
        for (let i = 0; i < size; i += 1) {
          this.skip(elemType);
        }
        return;
      }
      case T_MAP: {
        const size = this.varint();
        if (size > 0) {
          const kv = this.byte();
          const keyType = (kv & 0xf0) >> 4;
          const valType = kv & 0x0f;
          for (let i = 0; i < size; i += 1) {
            this.skip(keyType);
            this.skip(valType);
          }
        }
        return;
      }
      case T_STRUCT: {
        let prev = 0;
        for (;;) {
          const f = this.fieldHeader(prev);
          if (f.type === T_STOP) {
            return;
          }
          this.skip(f.type);
          prev = f.id;
        }
      }
      default:
        throw new Error(`parquet footer: cannot skip thrift type ${type}`);
    }
  }

  // --- parquet.thrift structure readers -----------------------------------

  private readStatistics(): { min?: Uint8Array; max?: Uint8Array } {
    // Statistics { 1: max (deprecated), 2: min (deprecated), 5: max_value, 6: min_value }
    let prev = 0;
    let min: Uint8Array | undefined;
    let max: Uint8Array | undefined;
    let minValue: Uint8Array | undefined;
    let maxValue: Uint8Array | undefined;
    for (;;) {
      const f = this.fieldHeader(prev);
      if (f.type === T_STOP) break;
      if (f.id === 1 && f.type === T_BINARY) max = this.binary();
      else if (f.id === 2 && f.type === T_BINARY) min = this.binary();
      else if (f.id === 5 && f.type === T_BINARY) maxValue = this.binary();
      else if (f.id === 6 && f.type === T_BINARY) minValue = this.binary();
      else this.skip(f.type);
      prev = f.id;
    }
    return { min: minValue ?? min, max: maxValue ?? max };
  }

  private readColumnMetaData(): ParquetColumnStats {
    // ColumnMetaData { 1: type, 3: path_in_schema (list<string>), 12: statistics }
    let prev = 0;
    let physicalType: number | null = null;
    const path: string[] = [];
    let stats: { min?: Uint8Array; max?: Uint8Array } = {};
    const decoder = new TextDecoder();
    for (;;) {
      const f = this.fieldHeader(prev);
      if (f.type === T_STOP) break;
      if (f.id === 1 && (f.type === T_I32 || f.type === T_I16)) {
        physicalType = this.zigzag();
      } else if (f.id === 3 && f.type === T_LIST) {
        const { size, elemType } = this.listHeader();
        for (let i = 0; i < size; i += 1) {
          if (elemType === T_BINARY) path.push(decoder.decode(this.binary()));
          else this.skip(elemType);
        }
      } else if (f.id === 12 && f.type === T_STRUCT) {
        stats = this.readStatistics();
      } else {
        this.skip(f.type);
      }
      prev = f.id;
    }
    return {
      path: path.join('.'),
      physicalType,
      ...(stats.min ? { minValue: stats.min } : {}),
      ...(stats.max ? { maxValue: stats.max } : {}),
    };
  }

  private readColumnChunk(): ParquetColumnStats | null {
    // ColumnChunk { 3: meta_data (ColumnMetaData) }
    let prev = 0;
    let column: ParquetColumnStats | null = null;
    for (;;) {
      const f = this.fieldHeader(prev);
      if (f.type === T_STOP) break;
      if (f.id === 3 && f.type === T_STRUCT) {
        column = this.readColumnMetaData();
      } else {
        this.skip(f.type);
      }
      prev = f.id;
    }
    return column;
  }

  private readRowGroup(): ParquetRowGroupStats {
    // RowGroup { 1: columns (list<ColumnChunk>), 3: num_rows }
    let prev = 0;
    const columns: ParquetColumnStats[] = [];
    let numRows = 0;
    for (;;) {
      const f = this.fieldHeader(prev);
      if (f.type === T_STOP) break;
      if (f.id === 1 && f.type === T_LIST) {
        const { size, elemType } = this.listHeader();
        for (let i = 0; i < size; i += 1) {
          if (elemType === T_STRUCT) {
            const col = this.readColumnChunk();
            if (col) columns.push(col);
          } else {
            this.skip(elemType);
          }
        }
      } else if (f.id === 3 && (f.type === T_I64 || f.type === T_I32)) {
        numRows = this.zigzag();
      } else {
        this.skip(f.type);
      }
      prev = f.id;
    }
    return { numRows, columns };
  }

  readFileMetaData(): ParquetFooterStats {
    // FileMetaData { 3: num_rows, 4: row_groups (list<RowGroup>) }
    let prev = 0;
    let numRows = 0;
    const rowGroups: ParquetRowGroupStats[] = [];
    for (;;) {
      const f = this.fieldHeader(prev);
      if (f.type === T_STOP) break;
      if (f.id === 3 && (f.type === T_I64 || f.type === T_I32)) {
        numRows = this.zigzag();
      } else if (f.id === 4 && f.type === T_LIST) {
        const { size, elemType } = this.listHeader();
        for (let i = 0; i < size; i += 1) {
          if (elemType === T_STRUCT) rowGroups.push(this.readRowGroup());
          else this.skip(elemType);
        }
      } else {
        this.skip(f.type);
      }
      prev = f.id;
    }
    return { numRows, rowGroups };
  }
}

/**
 * Parse the Thrift-compact `FileMetaData` bytes (the footer, excluding the
 * trailing 4-byte length + `PAR1` magic) into per-row-group column statistics.
 */
export function parseParquetFileMetaData(fileMetaDataBytes: Uint8Array): ParquetFooterStats {
  return new ThriftCompactReader(fileMetaDataBytes).readFileMetaData();
}

/** Decode a `Statistics` min/max value for an integer physical type (little-endian). */
export function decodeIntStat(bytes: Uint8Array | undefined, physicalType: number | null): number | null {
  if (!bytes || bytes.length === 0) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (physicalType === ParquetPhysicalType.INT32) {
    return bytes.length >= 4 ? view.getInt32(0, true) : null;
  }
  if (physicalType === ParquetPhysicalType.INT64) {
    // Feature codes fit comfortably in a JS number.
    return bytes.length >= 8 ? Number(view.getBigInt64(0, true)) : null;
  }
  return null;
}
