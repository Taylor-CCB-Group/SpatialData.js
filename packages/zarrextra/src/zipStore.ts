// The `/zip` subpath, never the `@zarrita/storage` barrel: the barrel also
// re-exports `FileSystemStore`, whose `node:` imports break browser bundles.
import ZipFileStore, { BlobReader } from '@zarrita/storage/zip';
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

type ZipEntries = Parameters<
  NonNullable<NonNullable<ConstructorParameters<typeof ZipFileStore>[1]>['transformEntries']>
>[0];

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
 * Drops macOS resource-fork entries, and roots the store at the archive's single
 * top-level folder when the archive root itself holds no zarr metadata.
 */
function normalizeEntries(entries: ZipEntries): ZipEntries {
  const names = Object.keys(entries).filter((name) => !name.startsWith('__MACOSX/'));
  const prefix = singleFolderPrefix(names);
  const normalized: ZipEntries = {};
  for (const name of names) {
    if (name.length > prefix.length) {
      normalized[name.slice(prefix.length)] = entries[name];
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
  readonly #zip: ZipFileStore;
  readonly #names: readonly string[];

  private constructor(zip: ZipFileStore, names: readonly string[]) {
    this.#zip = zip;
    this.#names = names;
  }

  /** Open an archive, reading its central directory. Rejects if it is not a zip. */
  static async open(source: ZipSource, options: ZipStoreOptions = {}): Promise<ZipStore> {
    let names: string[] = [];
    const zip = new ZipFileStore(toByteReader(source, options), {
      transformEntries: (entries) => {
        const normalized = normalizeEntries(entries);
        names = Object.keys(normalized);
        return normalized;
      },
    });
    // Any key will do: the first lookup awaits the central directory, which is
    // when `transformEntries` runs and when a bad archive or server rejects.
    await zip.has('/.zgroup');
    return new ZipStore(zip, names);
  }

  get(key: zarr.AbsolutePath): Promise<Uint8Array | undefined> {
    return this.#zip.get(key);
  }

  getRange(key: zarr.AbsolutePath, range: zarr.RangeQuery): Promise<Uint8Array | undefined> {
    return this.#zip.getRange(key, range);
  }

  /**
   * This store plus a `contents()` listing built from the archive's entry names,
   * for archives without consolidated metadata.
   */
  withListing(): Promise<zarr.Listable<zarr.AsyncReadable>> {
    return withEntryListing(this, this.#names);
  }
}
