import type * as zarr from 'zarrita';

type ListedNode = { path: zarr.AbsolutePath; kind: 'array' | 'group' };

const ROOT_METADATA = new Set(['zarr.json', '.zgroup', '.zarray', '.zattrs', '.zmetadata']);
const decoder = new TextDecoder();

/**
 * The prefix to strip so a store is rooted at its single top-level folder, or ''
 * when the root itself holds zarr metadata — the difference between archiving a
 * `foo.zarr` folder and archiving its contents.
 */
export function singleFolderPrefix(names: readonly string[]): string {
  if (names.some((name) => ROOT_METADATA.has(name))) {
    return '';
  }
  const topLevel = new Set(names.map((name) => name.split('/')[0]));
  const [folder] = topLevel;
  return topLevel.size === 1 && names.some((name) => name.startsWith(`${folder}/`))
    ? `${folder}/`
    : '';
}

/**
 * A `contents()` listing from relative file names, for stores whose files can be
 * enumerated but that carry no consolidated metadata.
 *
 * Zarr v3 nodes only say whether they are arrays or groups inside `zarr.json`,
 * so each one is read; v2 nodes are told apart by file name alone.
 */
export async function withEntryListing(
  store: zarr.AsyncReadable,
  names: readonly string[]
): Promise<zarr.Listable<zarr.AsyncReadable>> {
  const contents: ListedNode[] = [];
  for (const name of names) {
    const match = /^(?:(.*)\/)?(zarr\.json|\.zarray|\.zgroup)$/.exec(name);
    if (!match) continue;
    const [, dir = '', file] = match;
    const path: zarr.AbsolutePath = `/${dir}`;
    if (file === '.zarray') {
      contents.push({ path, kind: 'array' });
    } else if (file === '.zgroup') {
      contents.push({ path, kind: 'group' });
    } else {
      const bytes = await store.get(`/${name}`);
      const nodeType: unknown = bytes && JSON.parse(decoder.decode(bytes)).node_type;
      if (nodeType === 'array' || nodeType === 'group') {
        contents.push({ path, kind: nodeType });
      }
    }
  }
  return {
    get: store.get.bind(store),
    getRange: store.getRange?.bind(store),
    contents: () => contents,
  };
}
