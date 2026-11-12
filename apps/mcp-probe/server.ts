import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from '@modelcontextprotocol/ext-apps/server';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Beside server.ts when run from source; one level up from the bundled dist/server/main.js.
const VIEW_CANDIDATES = [
  path.join(HERE, 'dist', 'mcp-app.html'),
  path.join(HERE, '..', 'mcp-app.html'),
];
const RESOURCE_URI = 'ui://spatialdata/probe.html';

/**
 * A public HTTPS store (the demo's default) and a loopback one (`pnpm test:server`):
 * one run then says both whether the tile can range-read the web and whether it can
 * reach a store served on this machine.
 */
const DEFAULT_STORE_URLS = [
  'https://oranus.cmd.ox.ac.uk/publicprojects/project/13/spatial/Atera_v1_WTA_Kidney_non_diseased_FFPE.zarr',
  'http://localhost:38473/test-fixtures/v0.8.0/blobs.zarr',
];

function listEnv(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function defaultStoreUrls(): string[] {
  const fromEnv = listEnv('STORE_URLS');
  return fromEnv.length > 0 ? fromEnv : DEFAULT_STORE_URLS;
}

/**
 * Origins the View may fetch from. The host turns this into the iframe's
 * `connect-src`, so every origin the View touches must be listed. CSP matches
 * hosts literally, so a `localhost` origin also gets its `127.0.0.1` twin.
 */
export function connectDomains(): string[] {
  const origins = new Set(listEnv('STORE_ORIGINS'));
  for (const url of defaultStoreUrls()) origins.add(new URL(url).origin);
  for (const origin of [...origins]) {
    const url = new URL(origin);
    if (url.hostname === 'localhost') origins.add(origin.replace('localhost', '127.0.0.1'));
    if (url.hostname === '127.0.0.1') origins.add(origin.replace('127.0.0.1', 'localhost'));
  }
  return [...origins];
}

/**
 * Stable iframe origin for stores that allowlist origins instead of replying
 * `Access-Control-Allow-Origin: *`. This is Claude's documented form; it only
 * applies to a server reached by URL, so it is omitted unless APP_MCP_URL is set.
 */
function appDomain(): string | undefined {
  const url = process.env.APP_MCP_URL;
  if (!url) return undefined;
  const hash = crypto.createHash('sha256').update(url).digest('hex').slice(0, 32);
  return `${hash}.claudemcpcontent.com`;
}

async function readView(): Promise<string> {
  for (const candidate of VIEW_CANDIDATES) {
    try {
      return await fs.readFile(candidate, 'utf-8');
    } catch {
      // Try the next layout.
    }
  }
  throw new Error(`View not built; looked for ${VIEW_CANDIDATES.join(', ')}`);
}

export function createServer(): McpServer {
  const server = new McpServer({ name: 'spatialdata-probe', version: '0.1.0' });

  registerAppTool(
    server,
    'open_spatial_probe',
    {
      title: 'Open SpatialData probe',
      description:
        'Open a tile that reports what the host sandbox allows a SpatialData.js viewer to do: ' +
        'WebGL2/WebGPU, blob and module workers, WebAssembly (main thread and in workers), ' +
        'range requests to a SpatialData store, and any CSP violations. The tile adds its ' +
        'results to the model context when it finishes.',
      inputSchema: z.object({
        store_urls: z
          .array(z.string().url())
          .describe(
            'SpatialData .zarr store or .zip URLs to range-read. Their origins must be ' +
              'allowlisted. Defaults to one public HTTPS store and one on localhost.'
          )
          .optional(),
      }),
      _meta: { ui: { resourceUri: RESOURCE_URI } },
    },
    async ({ store_urls }) => {
      const storeUrls = store_urls?.length ? store_urls : defaultStoreUrls();
      const allowed = connectDomains();
      const notes = storeUrls
        .map((url) => new URL(url).origin)
        .filter((origin) => !allowed.includes(origin))
        .map(
          (origin) =>
            `${origin} is not in the tile's connect-src; fetches to it will be blocked. ` +
            'Restart the server with STORE_ORIGINS including it.'
        );
      return {
        content: [{ type: 'text', text: ['Opened SpatialData probe.', ...notes].join(' ') }],
        structuredContent: { store_urls: storeUrls, connect_domains: allowed },
      };
    }
  );

  // Hidden from the model: the View calls this to put its results in the transcript.
  registerAppTool(
    server,
    'report_probe',
    {
      title: 'Report probe results',
      description: 'Called by the probe tile to hand its results back to the conversation.',
      inputSchema: z.object({ results: z.record(z.string(), z.unknown()) }),
      _meta: { ui: { resourceUri: RESOURCE_URI, visibility: ['app'] } },
    },
    async ({ results }) => ({
      content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
      structuredContent: results,
    })
  );

  registerAppResource(
    server,
    'SpatialData probe view',
    RESOURCE_URI,
    { mimeType: RESOURCE_MIME_TYPE },
    async () => {
      const html = await readView();
      const domain = appDomain();
      const resourceDomains = listEnv('RESOURCE_DOMAINS');
      return {
        contents: [
          {
            uri: RESOURCE_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: html,
            _meta: {
              ui: {
                csp: {
                  connectDomains: connectDomains(),
                  ...(resourceDomains.length > 0 ? { resourceDomains } : {}),
                },
                ...(domain ? { domain } : {}),
              },
            },
          },
        ],
      };
    }
  );

  return server;
}
