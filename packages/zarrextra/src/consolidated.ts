import type * as zarr from 'zarrita';
import type { ZAttrsAny } from './types';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export type NodeEntry = {
  path: zarr.AbsolutePath;
  kind: 'array' | 'group';
  /** The node's `.zarray`/`.zgroup`/`zarr.json` document. */
  metadata: ZAttrsAny;
  attrs: ZAttrsAny;
};

export function isRecord(value: unknown): value is ZAttrsAny {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function fetchJson(store: zarr.AsyncReadable, key: zarr.AbsolutePath): Promise<unknown> {
  const bytes = await store.get(key);
  if (!bytes) throw new Error(`No '${key}' in store`);
  return JSON.parse(decoder.decode(bytes));
}

/** Every metadata file in a `.zmetadata` document, keyed by absolute path. */
function filesFromV2(document: unknown): Map<string, ZAttrsAny> {
  if (
    !isRecord(document) ||
    document.zarr_consolidated_format !== 1 ||
    !isRecord(document.metadata)
  ) {
    throw new Error('Not v2 consolidated metadata');
  }
  const files = new Map<string, ZAttrsAny>();
  for (const [key, value] of Object.entries(document.metadata)) {
    if (isRecord(value)) files.set(`/${key}`, value);
  }
  return files;
}

/** Every `zarr.json` in a root `zarr.json` with `consolidated_metadata`, keyed by absolute path. */
function filesFromV3(document: unknown): Map<string, ZAttrsAny> {
  if (
    !isRecord(document) ||
    document.zarr_format !== 3 ||
    document.node_type !== 'group' ||
    !isRecord(document.consolidated_metadata) ||
    !isRecord(document.consolidated_metadata.metadata)
  ) {
    throw new Error('Root zarr.json has no consolidated_metadata');
  }
  const files = new Map<string, ZAttrsAny>([
    [
      '/zarr.json',
      {
        zarr_format: 3,
        node_type: 'group',
        attributes: isRecord(document.attributes) ? document.attributes : {},
      },
    ],
  ]);
  for (const [path, value] of Object.entries(document.consolidated_metadata.metadata)) {
    if (isRecord(value)) files.set(`${path.startsWith('/') ? '' : '/'}${path}/zarr.json`, value);
  }
  return files;
}

function nodesFromFiles(files: Map<string, ZAttrsAny>): NodeEntry[] {
  const nodes: NodeEntry[] = [];
  for (const [key, metadata] of files) {
    const split = key.lastIndexOf('/');
    const dir = key.slice(0, split);
    const file = key.slice(split + 1);
    const path: zarr.AbsolutePath = `/${key.slice(1, split)}`;
    if (file === 'zarr.json') {
      const { node_type: kind, attributes } = metadata;
      if (kind === 'array' || kind === 'group') {
        nodes.push({ path, kind, metadata, attrs: isRecord(attributes) ? attributes : {} });
      }
    } else if (file === '.zarray' || file === '.zgroup') {
      const attrs = files.get(`${dir}/.zattrs`);
      nodes.push({
        path,
        kind: file === '.zarray' ? 'array' : 'group',
        metadata,
        attrs: attrs ?? {},
      });
    }
  }
  return nodes;
}

/**
 * Load a store's consolidated metadata whole, so the tree can be built from it
 * with no further reads. zarrita's own `withConsolidatedMetadata` keeps that
 * document private, leaving only per-key `get()`s to rebuild it from.
 *
 * v3 is tried first: `zarr.json` is preferred where a store has both. Throws when
 * there is no consolidated metadata.
 */
export async function loadConsolidatedMetadata(store: zarr.AsyncReadable): Promise<{
  store: zarr.Listable<zarr.AsyncReadable>;
  nodes: NodeEntry[];
}> {
  const attempts: (() => Promise<Map<string, ZAttrsAny>>)[] = [
    async () => filesFromV3(await fetchJson(store, '/zarr.json')),
    async () => filesFromV2(await fetchJson(store, '/.zmetadata')),
    async () => filesFromV2(await fetchJson(store, '/zmetadata')),
  ];
  let firstError: unknown;
  for (const attempt of attempts) {
    try {
      const files = await attempt();
      const nodes = nodesFromFiles(files);
      return {
        store: {
          get: async (key, options) => {
            const known = files.get(key);
            return known ? encoder.encode(JSON.stringify(known)) : store.get(key, options);
          },
          getRange: store.getRange?.bind(store),
          contents: () => nodes.map(({ path, kind }) => ({ path, kind })),
        },
        nodes,
      };
    } catch (error) {
      firstError ??= error;
    }
  }
  throw firstError;
}
