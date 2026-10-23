import type * as zarr from 'zarrita';
import { singleFolderPrefix, withEntryListing } from './entryListing';

/**
 * A file from a folder picker. Typed structurally so this package needs no DOM
 * lib: a DOM `File` from `<input webkitdirectory>` matches it.
 */
export type PickedFile = Blob & { readonly name: string; readonly webkitRelativePath?: string };

/**
 * A read-only zarr store over the files of a picked folder, as
 * `<input type="file" webkitdirectory>` hands them over.
 *
 * Every file's `webkitRelativePath` starts with the picked folder's own name,
 * which is stripped, so picking the `.zarr` folder roots the store there;
 * picking its parent works too when the `.zarr` folder is its only child.
 * Reads are `Blob.slice`s, so nothing is read until a key is asked for.
 */
export class FolderStore implements zarr.AsyncReadable {
  readonly #files: ReadonlyMap<string, Blob>;

  private constructor(files: ReadonlyMap<string, Blob>) {
    this.#files = files;
  }

  static fromFiles(files: Iterable<PickedFile> | ArrayLike<PickedFile>): FolderStore {
    const byPath = new Map<string, Blob>();
    for (const file of Array.from(files)) {
      const relative = file.webkitRelativePath || file.name;
      // The first segment is the picked folder itself.
      byPath.set(
        relative.includes('/') ? relative.slice(relative.indexOf('/') + 1) : relative,
        file
      );
    }
    const prefix = singleFolderPrefix([...byPath.keys()]);
    if (!prefix) {
      return new FolderStore(byPath);
    }
    const rooted = new Map<string, Blob>();
    for (const [path, file] of byPath) {
      if (path.length > prefix.length) {
        rooted.set(path.slice(prefix.length), file);
      }
    }
    return new FolderStore(rooted);
  }

  async get(key: zarr.AbsolutePath): Promise<Uint8Array | undefined> {
    const file = this.#files.get(key.slice(1));
    return file && new Uint8Array(await file.arrayBuffer());
  }

  async getRange(key: zarr.AbsolutePath, range: zarr.RangeQuery): Promise<Uint8Array | undefined> {
    const file = this.#files.get(key.slice(1));
    if (!file) {
      return undefined;
    }
    const slice =
      'suffixLength' in range
        ? file.slice(Math.max(0, file.size - range.suffixLength))
        : file.slice(range.offset, range.offset + range.length);
    return new Uint8Array(await slice.arrayBuffer());
  }

  /** This store plus a `contents()` listing of its files, for folders without consolidated metadata. */
  withListing(): Promise<zarr.Listable<zarr.AsyncReadable>> {
    return withEntryListing(this, [...this.#files.keys()]);
  }
}
