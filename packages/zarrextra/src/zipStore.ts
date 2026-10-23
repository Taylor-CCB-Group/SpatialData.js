// unzipit >= 2.1 directly, not through @zarrita/storage's ZipFileStore: that pins
// unzipit 2.0.0, whose literal `import('worker_threads')` fails webpack builds.
import { BlobReader, unzip, type ZipEntry } from 'unzipit';
import type * as zarr from 'zarrita';
import { singleFolderPrefix, withEntryListing } from './entryListing';

/**
 * Random-access bytes of a zip archive. The same shape as unzipit's `Reader`,
 * so a caller can supply any byte source — for example a Node `FileHandle`,
 * which is the way to open a local archive over 4 GiB in Node: `fs.openAsBlob`
 * reports such files' size modulo 2^32, so the archive's end cannot be found.
 */
export interface ZipByteReader {
  getLength(): Promise<number>;
  read(offset: number, length: number): Promise<Uint8Array<ArrayBuffer>>;
}

/** A URL to range-read over HTTP, a `Blob`/`File`, or any {@link ZipByteReader}. */
export type ZipSource = string | URL | Blob | ZipByteReader;

export interface ZipStoreOptions {
  /** Extra `fetch` options (headers, credentials) for URL sources. */
  requestInit?: RequestInit;
}

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const STORED = 0;

/**
 * Where an entry's local file header starts. unzipit parses it from the central
 * directory (zip64-aware) but keeps it on a private field, so read it defensively.
 */
function localHeaderOffset(entry: ZipEntry): number {
  const raw: unknown = Reflect.get(entry, '_rawEntry');
  if (
    typeof raw === 'object' &&
    raw !== null &&
    'relativeOffsetOfLocalHeader' in raw &&
    typeof raw.relativeOffsetOfLocalHeader === 'number'
  ) {
    return raw.relativeOffsetOfLocalHeader;
  }
  throw new Error('This unzipit version no longer exposes entry offsets; range reads need them.');
}

/**
 * Range-reads a URL, refusing any response that is not 206 Partial Content.
 *
 * A server that ignores `Range` answers 200 with the whole archive; reading
 * that as the requested slice would hand unzipit the wrong bytes, after
 * downloading what may be tens of gigabytes.
 */
class HttpRangeReader implements ZipByteReader {
  #length: Promise<number> | undefined;

  constructor(
    private readonly url: string,
    private readonly init: RequestInit = {}
  ) {}

  getLength(): Promise<number> {
    this.#length ??= this.#fetchLength();
    return this.#length;
  }

  async read(offset: number, length: number): Promise<Uint8Array<ArrayBuffer>> {
    if (length === 0) {
      return new Uint8Array(0);
    }
    const response = await this.#fetchRange(offset, offset + length - 1);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== length) {
      throw new Error(
        `Range request for ${this.url} returned ${bytes.length} bytes, expected ${length}.`
      );
    }
    return bytes;
  }

  async #fetchLength(): Promise<number> {
    const head = await fetch(this.url, { ...this.init, method: 'HEAD' });
    if (!head.ok) {
      throw new Error(`HEAD ${this.url} failed: ${head.status} ${head.statusText}`);
    }
    const contentLength = Number(head.headers.get('content-length') ?? Number.NaN);
    if (Number.isFinite(contentLength) && contentLength > 0) {
      return contentLength;
    }
    // Cross-origin responses hide Content-Length unless the server exposes it;
    // Content-Range on a one-byte read carries the total size instead.
    const probe = await this.#fetchRange(0, 0);
    await probe.body?.cancel();
    const total = Number(probe.headers.get('content-range')?.split('/')[1] ?? Number.NaN);
    if (!Number.isFinite(total)) {
      throw new Error(
        `Could not determine the size of ${this.url}: the server exposes neither ` +
          'Content-Length nor Content-Range.'
      );
    }
    return total;
  }

  async #fetchRange(start: number, end: number): Promise<Response> {
    const headers = new Headers(this.init.headers);
    headers.set('Range', `bytes=${start}-${end}`);
    const response = await fetch(this.url, { ...this.init, headers });
    if (response.status !== 206) {
      await response.body?.cancel();
      throw new Error(
        `${this.url} answered ${response.status} to a range request; zipped stores ` +
          'need a server that honours Range (206 Partial Content).'
      );
    }
    return response;
  }
}

function isByteReader(source: ZipSource): source is ZipByteReader {
  return (
    typeof source === 'object' &&
    'getLength' in source &&
    typeof source.getLength === 'function' &&
    'read' in source &&
    typeof source.read === 'function'
  );
}

function toByteReader(source: ZipSource, options: ZipStoreOptions): ZipByteReader {
  if (typeof source === 'string' || source instanceof URL) {
    return new HttpRangeReader(source.toString(), options.requestInit);
  }
  if (isByteReader(source)) {
    return source;
  }
  return new BlobReader(source);
}

/**
 * Drops macOS resource-fork entries and directory entries, and roots the store at
 * the archive's single top-level folder when the archive root holds no zarr metadata.
 */
function normalizeEntries(entries: Record<string, ZipEntry>): Map<string, ZipEntry> {
  const names = Object.keys(entries).filter(
    (name) => !name.startsWith('__MACOSX/') && !entries[name].isDirectory
  );
  const prefix = singleFolderPrefix(names);
  const normalized = new Map<string, ZipEntry>();
  for (const name of names) {
    if (name.length > prefix.length) {
      normalized.set(name.slice(prefix.length), entries[name]);
    }
  }
  return normalized;
}

/**
 * A read-only zarr store over a zip archive, local or remote.
 *
 * Range reads into STORED (uncompressed) entries go straight to the archive's
 * bytes, so a remote archive is never downloaded whole; DEFLATE entries are
 * inflated whole on every read, so zip zarr stores without compression.
 *
 * Deliberately has no `url` property: readers that stream parquet by URL check
 * for one, and a path inside an archive is not a fetchable URL.
 */
export class ZipStore implements zarr.AsyncReadable {
  readonly #reader: ZipByteReader;
  readonly #entries: ReadonlyMap<string, ZipEntry>;
  /** Where each entry's data starts, read from its local header once. */
  readonly #dataOffsets = new Map<string, Promise<number>>();

  private constructor(reader: ZipByteReader, entries: ReadonlyMap<string, ZipEntry>) {
    this.#reader = reader;
    this.#entries = entries;
  }

  /** Open an archive, reading its central directory. Rejects if it is not a zip. */
  static async open(source: ZipSource, options: ZipStoreOptions = {}): Promise<ZipStore> {
    const reader = toByteReader(source, options);
    const { entries } = await unzip(reader);
    return new ZipStore(reader, normalizeEntries(entries));
  }

  async get(key: zarr.AbsolutePath): Promise<Uint8Array | undefined> {
    const entry = this.#entries.get(key.slice(1));
    return entry && new Uint8Array(await entry.arrayBuffer());
  }

  async getRange(key: zarr.AbsolutePath, range: zarr.RangeQuery): Promise<Uint8Array | undefined> {
    const name = key.slice(1);
    const entry = this.#entries.get(name);
    if (!entry) {
      return undefined;
    }
    const [start, length] =
      'suffixLength' in range
        ? [Math.max(0, entry.size - range.suffixLength), Math.min(range.suffixLength, entry.size)]
        : [range.offset, Math.max(0, Math.min(range.length, entry.size - range.offset))];
    if (entry.compressionMethod !== STORED || entry.encrypted) {
      const bytes = new Uint8Array(await entry.arrayBuffer());
      return bytes.subarray(start, start + length);
    }
    return this.#reader.read((await this.#dataOffset(name, entry)) + start, length);
  }

  /**
   * This store plus a `contents()` listing built from the archive's entry names,
   * for archives without consolidated metadata.
   */
  withListing(): Promise<zarr.Listable<zarr.AsyncReadable>> {
    return withEntryListing(this, [...this.#entries.keys()]);
  }

  #dataOffset(name: string, entry: ZipEntry): Promise<number> {
    let offset = this.#dataOffsets.get(name);
    if (!offset) {
      offset = this.#readDataOffset(entry);
      this.#dataOffsets.set(name, offset);
    }
    return offset;
  }

  async #readDataOffset(entry: ZipEntry): Promise<number> {
    const headerStart = localHeaderOffset(entry);
    const bytes = await this.#reader.read(headerStart, 30);
    const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (header.getUint32(0, true) !== LOCAL_FILE_HEADER_SIGNATURE) {
      throw new Error(`No local file header for zip entry '${entry.name}'.`);
    }
    // Name and extra-field lengths here can differ from the central directory's.
    return headerStart + 30 + header.getUint16(26, true) + header.getUint16(28, true);
  }
}
