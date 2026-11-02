import * as zarr from 'zarrita';
import { FolderStore } from './folderStore';
import { Err, Ok, type Result } from './result';
import { getArrayMetadata, getNodeAttrs } from './treeNodes';
import type {
  ConsolidatedStore,
  LazyZarrArray,
  StoreReference,
  ZAttrsAny,
  ZarrTree,
} from './types';
import { ATTRS_KEY, ZARRAY_KEY } from './types';
import { isZipUrl, ZipStore } from './zipStore';

const decoder = new TextDecoder();

function isReadableStore(source: StoreReference): source is zarr.Readable {
  return typeof source !== 'string';
}

function isListableStore(store: zarr.Readable): store is zarr.Listable<zarr.Readable> {
  return 'contents' in store && typeof store.contents === 'function';
}

function normalizeStringSource(source: string): string {
  return source.replace(/\/+$/, '');
}

function describeSource(source: StoreReference): string {
  return typeof source === 'string' ? source : '[store instance]';
}

function isRecord(value: unknown): value is ZAttrsAny {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type MetadataFormat = 'v2' | 'v3';

async function readJson(store: zarr.Readable, key: string): Promise<ZAttrsAny | undefined> {
  const bytes = await store.get(key as zarr.AbsolutePath);
  return bytes ? JSON.parse(decoder.decode(bytes)) : undefined;
}

/**
 * Which metadata files a store without consolidated metadata uses, decided once at
 * the root so no other node probes for the wrong one. `zarr.json` wins when a
 * store carries both, as some do for backwards compatibility.
 */
async function detectMetadataFormat(store: zarr.Readable): Promise<MetadataFormat> {
  if (await store.get('/zarr.json')) return 'v3';
  if (await store.get('/.zgroup')) return 'v2';
  throw new Error("No 'zarr.json' or '.zgroup' at the store root");
}

/**
 * A node's metadata and attributes straight from the store's metadata files —
 * served from consolidated metadata where there is any — rather than opening it.
 */
async function readNodeMetadata(
  store: zarr.Readable,
  path: zarr.AbsolutePath,
  kind: 'array' | 'group',
  format: MetadataFormat
): Promise<{ metadata: ZAttrsAny; attrs: ZAttrsAny }> {
  const base = path === '/' ? '' : path;
  if (format === 'v3') {
    const metadata = await readJson(store, `${base}/zarr.json`);
    if (!metadata) throw new Error(`Missing node metadata for '${path}'`);
    const { attributes } = metadata;
    return { metadata, attrs: isRecord(attributes) ? attributes : {} };
  }
  const [metadata, attrs] = await Promise.all([
    readJson(store, `${base}/${kind === 'array' ? '.zarray' : '.zgroup'}`),
    readJson(store, `${base}/.zattrs`),
  ]);
  if (!metadata) throw new Error(`Missing ${kind} metadata for '${path}'`);
  return { metadata, attrs: attrs ?? {} };
}

function sortContentsByDepth(
  a: { path: zarr.AbsolutePath },
  b: { path: zarr.AbsolutePath }
): number {
  const depthA = a.path.split('/').filter(Boolean).length;
  const depthB = b.path.split('/').filter(Boolean).length;
  return depthA - depthB;
}

async function parseStoreContents(
  store: zarr.Listable<zarr.Readable>,
  knownFormat: MetadataFormat | undefined
): Promise<ZarrTree> {
  const format = knownFormat ?? (await detectMetadataFormat(store));
  const root = zarr.root(store);
  const tree: ZarrTree = {
    [ATTRS_KEY]: (await readNodeMetadata(store, '/', 'group', format)).attrs,
  };
  const contents = store.contents().sort(sortContentsByDepth);

  for (const { path, kind } of contents) {
    if (path === '/') continue;

    const pathParts = path.split('/').filter(Boolean);
    let currentNode = tree;

    for (const [index, part] of pathParts.entries()) {
      if (!(part in currentNode)) {
        const isLeaf = index === pathParts.length - 1;

        if (!isLeaf) {
          currentNode[part] = {};
        } else {
          const absolutePath = `/${pathParts.slice(0, index + 1).join('/')}` as zarr.AbsolutePath;
          const { metadata, attrs } = await readNodeMetadata(store, absolutePath, kind, format);

          if (kind === 'array') {
            const leafNode: LazyZarrArray<zarr.DataType> = {
              [ATTRS_KEY]: attrs,
              [ZARRAY_KEY]: metadata,
              get: () => zarr.open(root.resolve(absolutePath), { kind: 'array' }),
            };
            currentNode[part] = leafNode;
          } else {
            currentNode[part] = {
              [ATTRS_KEY]: attrs,
            };
          }
        }
      }

      currentNode = currentNode[part] as ZarrTree;
    }
  }

  return tree;
}

type ListableStore = {
  store: zarr.Listable<zarr.Readable>;
  /** Set when the store's consolidated metadata says which format it is. */
  format?: MetadataFormat;
};

async function resolveListableStore(source: StoreReference): Promise<ListableStore> {
  const store = isReadableStore(source)
    ? source
    : isZipUrl(source)
      ? await ZipStore.open(source.trim())
      : new zarr.FetchStore(normalizeStringSource(source));

  if (isListableStore(store)) {
    return { store };
  }

  // One format at a time rather than letting zarrita auto-detect, so the format
  // that loaded is the one the tree is read in. v3 first: `zarr.json` is
  // preferred where a store has both.
  const attempts: { format: MetadataFormat; metadataKey?: string }[] = [
    { format: 'v3' },
    { format: 'v2' },
    { format: 'v2', metadataKey: 'zmetadata' },
  ];
  let firstError: unknown;
  for (const { format, metadataKey } of attempts) {
    try {
      const consolidated = await zarr.withConsolidatedMetadata(store as zarr.AsyncReadable, {
        format,
        metadataKey,
      });
      return { store: consolidated, format };
    } catch (error) {
      firstError ??= error;
    }
  }
  // Consolidated metadata comes first even for stores that can list their
  // files: the tree walk below opens every listed node, one read each,
  // where consolidated metadata is a single read.
  if (store instanceof ZipStore || store instanceof FolderStore) {
    return { store: await store.withListing() };
  }
  throw firstError;
}

/**
 * Open a zarr store or store-backed source and return a parsed tree representation.
 */
export async function openExtraConsolidated(
  source: StoreReference
): Promise<Result<ConsolidatedStore>> {
  try {
    const { store: zarritaStore, format } = await resolveListableStore(source);
    const tree = await parseStoreContents(zarritaStore, format);
    return Ok({ zarritaStore, tree });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return Err(new Error(`Failed to open zarr store '${describeSource(source)}': ${errorMessage}`));
  }
}

/**
 * Deep clone a ZarrTree, converting Symbol-keyed attrs to string keys for serialization/debugging
 */
export function serializeZarrTree(obj: ZarrTree | unknown): unknown {
  if (obj === null || typeof obj !== 'object') return obj;

  const result: Record<string, unknown> = {};

  const attrs = getNodeAttrs(obj);
  if (attrs) {
    result._attrs = attrs;
  }
  const arrayMetadata = getArrayMetadata(obj);
  if (arrayMetadata) {
    result._zarray = arrayMetadata;
  }

  for (const key in obj) {
    if (Object.hasOwn(obj, key)) {
      // @ts-expect-error - Indexing unknown object for serialization.
      const val = obj[key];
      if (typeof val === 'function') {
        result[key] = '<function>';
      } else {
        result[key] = serializeZarrTree(val);
      }
    }
  }

  return result;
}

export type { ChunkCache } from '@fideus-labs/fizarrita';
export { getZarrChunk, type ZarrGetOptions } from './chunkDecode';
export {
  createOpenJpegDecoder,
  createOpenJphDecoder,
  createWasmLocateFile,
  type ImageCodecDecoder,
  type OpenJpegFactory,
  type OpenJphDecode,
  type OpenJphDecodedImage,
  type OpenJphInitOptions,
  type RegisterImageCodecOptions,
  registerExperimentalHtj2kCodec,
  registerJpeg2kCodec,
} from './codecs';
export { FolderStore, type PickedFile } from './folderStore';
export {
  createOpenJphEncoder,
  encodeHtj2kPlane,
  type Htj2kEncodeOptions,
  type Htj2kPlane,
  type Htj2kPlaneDtype,
  loadOpenJphEncoder,
  type OpenJphEncode,
  type OpenJphEncodeInput,
  type OpenJphEncoder,
  planeArrayForDtype,
} from './htj2k-encode';
export {
  loadOmeZarrMultiscalesFromStore,
  type RasterSelection,
  type VivCompatiblePixelSource,
} from './omeZarr';
export { createPrefixedStore } from './prefixedStore';
export type { Result } from './result';
export { Err, isErr, isOk, Ok, unwrap, unwrapOr } from './result';
export type { ZarrDataType } from './treeNodes';
export {
  getArrayDtype,
  getArrayMetadata,
  getChildArray,
  getChildGroup,
  getChildNode,
  getNodeAttrs,
  isLazyZarrArray,
  isTextDataType,
  isZarrGroup,
  normalizeDtype,
} from './treeNodes';
export type {
  ConsolidatedStore,
  LazyZarrArray,
  StoreReference,
  ZAttrsAny,
  ZarrArrayMetadata,
  ZarrTree,
  ZarrV2ArrayNode,
  ZarrV3ArrayNode,
} from './types';
export { ATTRS_KEY, ZARRAY_KEY } from './types';
export {
  isZipUrl,
  type ZipByteReader,
  type ZipSource,
  ZipStore,
  type ZipStoreOptions,
} from './zipStore';
