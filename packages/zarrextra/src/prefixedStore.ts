import type * as zarr from 'zarrita';

function toAbsolutePath(path: string): zarr.AbsolutePath {
  const trimmed = path.replace(/^\/+|\/+$/g, '');
  // Zarrita brands absolute paths as template-literal types; normalization above enforces it.
  return (trimmed ? `/${trimmed}` : '/') as zarr.AbsolutePath;
}

function joinAbsolutePath(prefix: string, key: zarr.AbsolutePath): zarr.AbsolutePath {
  const normalizedPrefix = toAbsolutePath(prefix);
  if (normalizedPrefix === '/') {
    return key;
  }
  if (key === '/') {
    return normalizedPrefix;
  }
  // Both sides are absolute Zarr paths; concatenating preserves the leading slash.
  return `${normalizedPrefix}${key}` as zarr.AbsolutePath;
}

/**
 * Create a read-only store view rooted at `prefix`.
 *
 * This is useful when callers have a SpatialData root store but a downstream
 * reader expects the supplied store root to be an individual image/table group.
 */
export function createPrefixedStore(store: zarr.Readable, prefix: string): zarr.AsyncReadable {
  return {
    async get(key: zarr.AbsolutePath, opts?: zarr.GetOptions) {
      return await store.get(joinAbsolutePath(prefix, key), opts);
    },
    getRange: store.getRange
      ? async (key: zarr.AbsolutePath, range: zarr.RangeQuery, opts?: zarr.GetOptions) =>
          await store.getRange?.(joinAbsolutePath(prefix, key), range, opts)
      : undefined,
  };
}
